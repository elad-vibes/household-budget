// Helpers around Claude responses: text extraction, refusal/length checks,
// and strict sanitizing of everything the model returns before it is stored
// or sent to the app.
import type Anthropic from "@anthropic-ai/sdk";
import { ALLCATS, CATS, isLinkId, type LinkId } from "./catalog.ts";
import { HttpError } from "./http.ts";

export function textOf(msg: Anthropic.Message): string {
  if (msg.stop_reason === "refusal") throw new HttpError(422, "refused", "Claude לא עיבד את הקלט הזה.");
  if (msg.stop_reason === "max_tokens") throw new HttpError(422, "too_long", "המסמך ארוך מדי לקריאה אחת. אפשר לפצל אותו.");
  let out = "";
  for (const block of msg.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

export function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Structured outputs make this rare; tolerate a stray fence anyway.
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch { /* fall through */ }
    }
    throw new HttpError(502, "invalid_json", "התשובה לא הגיעה בפורמט הנכון. כדאי לנסות שוב.");
  }
}

const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------- statement
export interface StatementRow {
  date: string; month: string; merchant: string; amount: number; category: string; fixed: boolean; note: string;
}
export interface StatementDoc {
  docType: string; title: string; statementTotal: number | null; rows: StatementRow[];
}

export function sanitizeStatement(raw: any): StatementDoc {
  const rows: StatementRow[] = [];
  for (const r of Array.isArray(raw?.rows) ? raw.rows.slice(0, 600) : []) {
    const amount = num(r?.amount);
    if (amount === null || amount === 0) continue;
    let date = str(r?.date, 10);
    if (!DATE.test(date)) date = "";
    let month = str(r?.month, 7);
    if (!MONTH.test(month)) month = date ? date.slice(0, 7) : "";
    if (!month) continue;
    rows.push({
      date: date || `${month}-01`,
      month,
      merchant: str(r?.merchant, 80) || "לא ידוע",
      amount,
      category: ALLCATS.includes(r?.category) ? r.category : "שונות",
      fixed: r?.fixed === true,
      note: str(r?.note, 60),
    });
  }
  const docType = ["credit_card", "bank", "receipt", "other"].includes(raw?.docType) ? raw.docType : "other";
  return { docType, title: str(raw?.title, 80) || "מסמך", statementTotal: num(raw?.statementTotal), rows };
}

// ----------------------------------------------------------------- receipts
export interface ReceiptItem { name: string; qty: number; unit_price: number | null; total: number | null }
export interface Receipt { merchant: string; date: string; total: number; category: string; note: string; items: ReceiptItem[]; payment: string }

export function sanitizeReceipt(raw: any): { ok: true; receipt: Receipt } | { ok: false; reason: string } {
  if (!raw || raw.is_receipt === false) return { ok: false, reason: "unreadable" };
  const total = num(raw.total);
  if (total === null || total === 0 || Math.abs(total) > 100_000) return { ok: false, reason: "unreadable" };
  const date = DATE.test(str(raw.date, 10)) ? str(raw.date, 10) : "";
  const items: ReceiptItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items.slice(0, 120) : []) {
    const name = str(it?.name, 80);
    if (!name) continue;
    const qty = num(it?.qty);
    items.push({ name, qty: qty && qty > 0 && qty < 1000 ? qty : 1, unit_price: num(it?.unit_price), total: num(it?.total) });
  }
  return {
    ok: true,
    receipt: {
      merchant: str(raw.merchant, 80) || "קבלה",
      date,
      total,
      category: (CATS as readonly string[]).includes(raw.category) ? raw.category : "שונות",
      note: str(raw.note, 60),
      items,
      // never more than the last 4 digits of a card number
      payment: str(raw.payment, 40).replace(/\d{5,}/g, (d) => "****" + d.slice(-4)),
    },
  };
}

// ----------------------------------------------------------------- analysis
export interface AnalysisTip { title: string; text: string; save: number | null; links: LinkId[] }
export interface AnalysisData { status: string; changes: string; tips: AnalysisTip[]; checks: string[] }

export function sanitizeAnalysis(raw: any): AnalysisData {
  if (!raw || typeof raw !== "object" || !raw.status) {
    throw new HttpError(502, "invalid_json", "התשובה לא הגיעה בפורמט הנכון. כדאי לנסות שוב.");
  }
  const tips = (Array.isArray(raw.tips) ? raw.tips : []).slice(0, 6).map((t: any) => {
    const save = num(t?.save);
    return {
      title: str(t?.title, 80),
      text: str(t?.text, 400),
      save: save && save > 0 ? Math.round(save) : null,
      links: (Array.isArray(t?.links) ? t.links : []).filter(isLinkId).slice(0, 3),
    };
  }).filter((t: AnalysisTip) => t.title && t.text);
  return {
    status: str(raw.status, 600),
    changes: str(raw.changes, 400),
    tips,
    checks: (Array.isArray(raw.checks) ? raw.checks : []).slice(0, 4).map((c: unknown) => str(c, 200)).filter(Boolean),
  };
}
