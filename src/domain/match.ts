// Payment methods + "no double counting" (payment-methods.md).
// A card / bit / transfer expense logged by hand or from a receipt waits for the
// statement ("awaiting_statement"). When the statement is imported, each of its
// rows is matched against the waiting items; a match MERGES the two: the logged
// row survives (category, note, person, line items) and takes the statement's
// amount and date. Pure functions — unit-tested in tests/unit/match.test.ts.

export type PmType = "cash" | "credit_card" | "debit_card" | "bank_transfer" | "standing_order" | "bit_paybox" | "other" | "voucher";

export interface PaymentMethod {
  id: string;
  household_id?: string;
  type: PmType;
  label: string;
  issuer: string;
  last4: string | null;
  person_id: string | null;
  active: boolean;
  sort: number;
}

export type MatchStatus = "none" | "awaiting_statement" | "matched" | "unmatched_after_statement";

export const PM_TYPES: Record<PmType, string> = {
  cash: "מזומן", credit_card: "כרטיס אשראי", debit_card: "כרטיס חיוב (דביט)", bank_transfer: "העברה בנקאית",
  standing_order: "הוראת קבע", bit_paybox: "ביט / פייבוקס", other: "אחר",
  voucher: "שובר",   // created by the voucher wallet (0014), never by hand
};

/** Types that show up later in a card or bank statement. Cash and "other" never do. */
const IN_STATEMENTS: readonly PmType[] = ["credit_card", "debit_card", "bank_transfer", "standing_order", "bit_paybox"];
export const awaitsStatement = (t: PmType | undefined | null) => !!t && IN_STATEMENTS.includes(t);
const BANKISH: readonly PmType[] = ["debit_card", "bank_transfer", "standing_order"];

/** The match_status a newly logged expense gets for this method. */
export function initialStatus(m: Pick<PaymentMethod, "type"> | null | undefined): MatchStatus {
  return awaitsStatement(m?.type) ? "awaiting_statement" : "none";
}

/** A logged expense that waits for its statement row. */
export interface Waiting { id: string; date: string; amount: number; merchant: string; methodId: string | null; foreign?: boolean }
/** A statement row (from an import, or already saved in the household). */
export interface SRow { key: string; date: string; month?: string; amount: number; merchant: string; note: string; methodId?: string | null }

export const DATE_BEFORE = 2; // the statement date may be up to 2 days before the receipt
export const DATE_AFTER = 5;  // … and up to 5 days after it
export const AMOUNT_TOL = 1;  // ₪
/** A purchase abroad was logged at the official rate; the card charges its own rate + fees (0015). */
export const FOREIGN_TOL = 0.05;
const tol = (w: Waiting) => (w.foreign ? Math.max(AMOUNT_TOL, Math.abs(w.amount) * FOREIGN_TOL) : AMOUNT_TOL);

// ------------------------------------------------------------ helpers
const day = (d: string) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);
export const daysBetween = (from: string, to: string) => day(to) - day(from);

const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
export function normMerchant(s: string): string {
  return s.toLowerCase().replace(/[ךםןףץ]/g, (c) => FINALS[c]).replace(/[^a-zא-ת]+/g, " ").trim();
}
const bigrams = (s: string) => { const out: string[] = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };

/** 0…1: how much two merchant names look like the same business. */
export function merchantSimilarity(a: string, b: string): number {
  const x = normMerchant(a), y = normMerchant(b);
  if (!x || !y) return 0;
  const xs = x.replace(/ /g, ""), ys = y.replace(/ /g, "");
  if (xs === ys) return 1;
  const firstTok = (s: string) => s.split(" ").find((t) => t.length >= 3) ?? "";
  const fx = firstTok(x), fy = firstTok(y);
  if ((fx && ys.includes(fx)) || (fy && xs.includes(fy))) return 0.8;
  const bx = bigrams(xs), by = bigrams(ys);
  if (!bx.length || !by.length) return 0;
  const pool = [...by];
  let hit = 0;
  for (const g of bx) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (bx.length + by.length);
}

const BIT_RE = /\bbit\b|ביט|paybox|פייבוקס|פיי בוקס/i;
export const isBitRow = (merchant: string) => BIT_RE.test(merchant);
const ATM_RE = /משיכת מזומן|משיכה מכספומט|כספומט|\batm\b/i;
export const isAtmRow = (merchant: string) => ATM_RE.test(merchant);

const sameIssuer = (a: PaymentMethod, b: PaymentMethod) =>
  !!a.issuer.trim() && normMerchant(a.issuer) === normMerchant(b.issuer);

/** May an item paid with `item` show up as this row of a statement of `st`? */
export function eligible(item: PaymentMethod | undefined, st: PaymentMethod, rowMerchant: string): boolean {
  if (!item || !awaitsStatement(item.type)) return false;
  if (item.id === st.id) return true;
  if (item.type === "bit_paybox") return isBitRow(rowMerchant);
  if (BANKISH.includes(st.type) && BANKISH.includes(item.type)) return sameIssuer(item, st);
  if (item.type === st.type && sameIssuer(item, st)) return !item.last4 || !st.last4 || item.last4 === st.last4;
  return false;
}

export interface PairInfo { kind: "amount" | "installment"; amountDiff: number; dayDiff: number; merchant: number; score: number; confident: boolean }

/** Amount (±1₪ — ±5% for a purchase abroad, same sign, or the first installment of the full amount) + date window. */
export function pairInfo(w: Waiting, r: SRow): PairInfo | null {
  if (Math.sign(w.amount) !== Math.sign(r.amount)) return null; // a refund only matches a refund
  const dd = daysBetween(w.date, r.date);
  if (dd < -DATE_BEFORE || dd > DATE_AFTER) return null;
  let kind: PairInfo["kind"] = "amount";
  let diff = Math.abs(w.amount - r.amount);
  if (diff > tol(w)) {
    const inst = r.note.match(/תשלום\s*1\s*מתוך\s*(\d+)/);
    const n = inst ? +inst[1] : 0;
    if (n < 2 || Math.abs(w.amount / n - r.amount) > AMOUNT_TOL) return null;
    kind = "installment";
    diff = Math.abs(w.amount / n - r.amount);
  }
  const merchant = merchantSimilarity(w.merchant, r.merchant);
  const confident = merchant >= 0.5 || (kind === "amount" && diff < 0.01 && Math.abs(dd) <= 2);
  const score = 3 - diff - Math.abs(dd) * 0.1 + merchant * 2 - (kind === "installment" ? 0.5 : 0);
  return { kind, amountDiff: diff, dayDiff: dd, merchant, score, confident };
}

export interface Merge { rowKey: string; itemId: string }
export interface Ambiguous { rowKey: string; candidates: { itemId: string; score: number }[] }
export interface MatchResult {
  merges: Merge[];         // automatic: one row ↔ one item, confident
  ambiguous: Ambiguous[];  // needs the user: several candidates, or a single unsure one
  covered: string[];       // waiting items this statement should contain (date range, method)
}

/**
 * Matches the rows of one imported statement (paid with `st`) against the
 * household's waiting items.
 */
export function matchStatement(items: Waiting[], rows: SRow[], st: PaymentMethod, methods: PaymentMethod[]): MatchResult {
  const byId = new Map(methods.map((m) => [m.id, m]));
  const pairs = new Map<string, { itemId: string; info: PairInfo }[]>();
  const rowsOfItem = new Map<string, string[]>();
  for (const r of rows) {
    const list: { itemId: string; info: PairInfo }[] = [];
    for (const w of items) {
      if (!eligible(byId.get(w.methodId ?? ""), st, r.merchant)) continue;
      const info = pairInfo(w, r);
      if (!info) continue;
      list.push({ itemId: w.id, info });
      rowsOfItem.set(w.id, [...(rowsOfItem.get(w.id) ?? []), r.key]);
    }
    if (list.length) pairs.set(r.key, list.sort((a, b) => b.info.score - a.info.score));
  }
  const merges: Merge[] = [];
  const ambiguous: Ambiguous[] = [];
  for (const r of rows) {
    const list = pairs.get(r.key);
    if (!list) continue;
    const only = list.length === 1 && (rowsOfItem.get(list[0].itemId) ?? []).length === 1;
    if (only && list[0].info.confident) merges.push({ rowKey: r.key, itemId: list[0].itemId });
    else ambiguous.push({ rowKey: r.key, candidates: list.map((p) => ({ itemId: p.itemId, score: Math.round(p.info.score * 100) / 100 })) });
  }
  // Waiting items this statement "covers": right method, and the statement runs
  // at least DATE_AFTER days past the item (so its row would already be here).
  let covered: string[] = [];
  if (rows.length) {
    const dates = rows.map((r) => r.date).sort();
    const min = dates[0], max = dates[dates.length - 1];
    covered = items.filter((w) => {
      const m = byId.get(w.methodId ?? "");
      const methodOk = m?.type === "bit_paybox" ? rows.some((r) => eligible(m, st, r.merchant)) : eligible(m, st, "");
      return methodOk && daysBetween(min, w.date) >= -DATE_BEFORE && daysBetween(w.date, max) >= DATE_AFTER;
    }).map((w) => w.id);
  }
  return { merges, ambiguous, covered };
}

/**
 * Final merges after the user answered the ambiguous rows (choice = item id,
 * or "" for "not one of mine"). One item merges into at most one row.
 * Leftovers = covered items that were not merged → "unmatched_after_statement".
 */
export function resolveMatches(res: MatchResult, choices: Record<string, string>): { merges: Merge[]; leftovers: string[] } {
  const merges = [...res.merges];
  const used = new Set(merges.map((m) => m.itemId));
  for (const a of res.ambiguous) {
    const pick = choices[a.rowKey];
    if (!pick || used.has(pick) || !a.candidates.some((c) => c.itemId === pick)) continue;
    merges.push({ rowKey: a.rowKey, itemId: pick });
    used.add(pick);
  }
  return { merges, leftovers: res.covered.filter((id) => !used.has(id)) };
}

/**
 * Statement first, receipt later: finds the one saved statement row a newly
 * logged item should merge into (null if none or unsure).
 */
export function findStatementRow(item: Waiting, rows: SRow[], methods: PaymentMethod[]): SRow | null {
  const byId = new Map(methods.map((m) => [m.id, m]));
  const im = byId.get(item.methodId ?? "");
  const hits = rows.filter((r) => {
    const st = byId.get(r.methodId ?? "");
    return st && eligible(im, st, r.merchant) && pairInfo(item, r)?.confident;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Guesses the payment method of an imported file / a receipt from its text. */
export function detectMethod(text: string, methods: PaymentMethod[]): PaymentMethod | null {
  const active = methods.filter((m) => m.active);
  const digits = [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((x) => x[1]);
  const byLast4 = active.filter((m) => m.last4 && digits.includes(m.last4));
  if (byLast4.length === 1) return byLast4[0];
  if (/מזומן|cash/i.test(text)) return active.find((m) => m.type === "cash") ?? null;
  const t = normMerchant(text);
  const byIssuer = active.filter((m) => m.issuer.trim() && awaitsStatement(m.type) && t.includes(normMerchant(m.issuer)));
  if (byIssuer.length === 1) return byIssuer[0];
  if (isBitRow(text)) return active.find((m) => m.type === "bit_paybox") ?? null;
  return null;
}
