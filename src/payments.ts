// Payment methods in the app (payment-methods.md): remembered choices, the
// "איך שילמת?" chips, settling a logged expense (statement already imported →
// merge now), statement-import matching, and the cards: methods manager (Home),
// "לבדוק" / cash / by-method (overview).
import { attr, html, type SafeHtml } from "./lib/html.ts";
import { armed2, isArmed, on } from "./lib/events.ts";
import { ils, ils2 } from "./lib/format.ts";
import { dbMessage } from "./lib/supa.ts";
import { canWrite, ctx, flash, rerender, S } from "./state.ts";
import { applyStatement, deletePaymentMethod, deleteTx, mergeStatementRow, savePaymentMethod, updateTx } from "./data.ts";
import { isExcl, personName, txOf } from "./domain/calc.ts";
import {
  awaitsStatement, detectMethod, findStatementRow, matchStatement, normMerchant, PM_TYPES, resolveMatches,
  type MatchResult, type PaymentMethod, type PmType, type SRow, type Waiting,
} from "./domain/match.ts";
import type { DraftDoc, Tx } from "./domain/types.ts";
import { overviewCards } from "./ui/overview.ts";
import { homeCards } from "./ui/home.ts";
import { personOptionsHtml } from "./ui/common.ts";

export const methodById = (id: string | null | undefined) => (id ? S.methods.find((m) => m.id === id) : undefined);
export const activeMethods = () =>
  S.methods.filter((m) => m.active).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
export const methodLabel = (m: PaymentMethod | undefined) => (m ? m.label + (m.last4 ? ` ••${m.last4}` : "") : "לא צוין");

// ---------------------------------------------------- remembered choices
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** The person's last "איך שילמת?" choice (default: cash). */
export function lastMethod(personId: string | null): string {
  const saved = lsGet(`hb2-pm:${S.hh}:${personId ?? ""}`);
  const m = methodById(saved);
  if (m?.active) return m.id;
  return activeMethods().find((x) => x.type === "cash")?.id ?? activeMethods()[0]?.id ?? "";
}
export const rememberMethod = (personId: string | null, id: string) => lsSet(`hb2-pm:${S.hh}:${personId ?? ""}`, id);

/** Statement files from the same source (same name without digits) remember their method. */
const srcKey = (title: string) => `hb2-pmsrc:${S.hh}:${normMerchant(title).slice(0, 40)}`;
export function guessStatementMethod(d: Pick<DraftDoc, "title" | "hint">): string {
  const remembered = methodById(lsGet(srcKey(d.title)));
  if (remembered?.active) return remembered.id;
  const found = detectMethod(d.hint || d.title, S.methods);
  return found && found.type !== "cash" ? found.id : "";
}

// ---------------------------------------------------- chips
export function methodChips(name: string, selected: string): SafeHtml {
  return html`<div class="seg chips" role="radiogroup" aria-label="איך שילמת?">${activeMethods().map((m) =>
    html`<button type="button" role="radio" aria-checked="${m.id === selected ? "true" : "false"}" data-click="pm-chip" data-name="${name}" data-v="${m.id}">${m.label}${m.last4 ? html` <span class="num">••${m.last4}</span>` : ""}</button>`)}</div>`;
}
export const chipValue = (name: string, fallback: string): string => S.extra["pm:" + name] ?? fallback;
on("click", "pm-chip", (el) => { S.extra["pm:" + el.dataset.name] = el.dataset.v; rerender(); });

export function methodSelect(id: string, selected: string | null | undefined, attrs: Record<string, string> = {}): SafeHtml {
  const list = S.methods.filter((m) => m.active || m.id === selected);
  return html`<select id="${id}" data-change="${attrs.change ?? ""}" data-id="${attrs.id ?? ""}" data-f="${attrs.f ?? ""}" ${attr(attrs.disabled === "1", "disabled")}><option value="">לא צוין</option>${list.map((m) => html`<option value="${m.id}" ${attr(m.id === selected, "selected")}>${methodLabel(m)}</option>`)}</select>`;
}

// ---------------------------------------------------- matching glue
const waiting = (): Waiting[] => S.tx
  .filter((t) => t.status === "saved" && (t.match_status === "awaiting_statement" || t.match_status === "unmatched_after_statement"))
  .map((t) => ({ id: t.id, date: t.date, amount: t.amount, merchant: t.merchant, methodId: t.payment_method_id ?? null, foreign: !!t.original_currency }));
export const waitingById = (id: string) => S.tx.find((t) => t.id === id);

const savedStatementRows = (): SRow[] => S.tx
  .filter((t) => (t.source === "import" || t.source === "statement") && (t.match_status ?? "none") === "none" && t.payment_method_id)
  .map((t) => ({ key: t.id, date: t.date, month: t.month, amount: t.amount, merchant: t.merchant, note: t.note, methodId: t.payment_method_id }));

/**
 * After a logged expense (manual / approved receipt) is saved with its method:
 * cash → counted now; card/bit/transfer → merged into an already-imported
 * statement row if there is exactly one, otherwise "ממתין לפירוט".
 */
export async function settle(t: Tx): Promise<string | null> {
  const m = methodById(t.payment_method_id);
  if (!awaitsStatement(m?.type)) {
    if ((t.match_status ?? "none") !== "none") await updateTx(t.id, { match_status: "none" });
    return null;
  }
  const row = findStatementRow({ id: t.id, date: t.date, amount: t.amount, merchant: t.merchant, methodId: m!.id }, savedStatementRows(), S.methods);
  if (row) {
    await mergeStatementRow(t.id, row.key);
    return "הותאם לשורה בפירוט שכבר הועלה — לא נספר פעמיים.";
  }
  if (t.match_status !== "awaiting_statement") await updateTx(t.id, { match_status: "awaiting_statement" });
  return null;
}

/** Matching of one statement draft against the waiting items (null = no method chosen). */
export function draftMatch(d: DraftDoc): MatchResult | null {
  const st = methodById(d.methodId);
  if (!st) return null;
  const rows = d.rows.filter((r) => r.keep).map((r) => ({ key: r.id, date: r.date, month: r.month, amount: r.amount, merchant: r.merchant, note: r.note }));
  return matchStatement(waiting(), rows, st, S.methods);
}

export async function saveDraftDoc(d: DraftDoc, personId: string | null) {
  const res = draftMatch(d);
  const { merges, leftovers } = res ? resolveMatches(res, d.choices) : { merges: [], leftovers: [] };
  const merged = new Set(merges.map((m) => m.rowKey));
  const rows = d.rows.filter((r) => r.keep && !merged.has(r.id)).map((r) => ({
    date: r.date, month: r.month, merchant: r.merchant, amount: r.amount, category: r.category, is_fixed: r.fixed,
    note: r.note, person_id: personId, source: d.source, source_title: d.title,
    ...(r.original_currency ? { original_amount: r.original_amount, original_currency: r.original_currency, fx_rate: r.fx_rate } : {}),
  }));
  const mergeRows = merges.map((m) => {
    const r = d.rows.find((x) => x.id === m.rowKey)!;
    return { id: m.itemId, date: r.date, month: r.month, amount: r.amount };
  });
  const method = methodById(d.methodId);
  if (method) lsSet(srcKey(d.title), method.id);
  return applyStatement(method?.id ?? null, rows, mergeRows, leftovers);
}

/** Short Hebrew line for a statement draft: "3 קבלות הותאמו לפירוט, 1 לא נמצאה". */
export function matchSummary(res: MatchResult, d: DraftDoc): string {
  const { merges, leftovers } = resolveMatches(res, d.choices);
  const parts: string[] = [];
  if (merges.length) parts.push(merges.length === 1 ? "קבלה אחת הותאמה לפירוט" : `${merges.length} קבלות הותאמו לפירוט`);
  if (leftovers.length) parts.push(leftovers.length === 1 ? "1 לא נמצאה" : `${leftovers.length} לא נמצאו`);
  return parts.join(", ");
}

// ---------------------------------------------------- badges
export function matchBadge(t: Tx): SafeHtml | string {
  if (t.match_status === "awaiting_statement") return html`<span class="chip info" title="יתואם אוטומטית כשהפירוט יועלה">ממתין לפירוט</span>`;
  if (t.match_status === "unmatched_after_statement") return html`<span class="chip warn">לא נמצא בפירוט</span>`;
  return "";
}

// ---------------------------------------------------- overview cards
overviewCards.push(() => {
  const list = S.tx.filter((t) => t.match_status === "unmatched_after_statement").sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return html``;
  const w = canWrite();
  return html`<div class="card"><div class="card-h"><h2>לבדוק</h2><span class="muted small">${list.length === 1 ? "הוצאה אחת" : `${list.length} הוצאות`} לא נמצאו בפירוט</span></div>
    <p class="muted small">הפירוט של אמצעי התשלום כבר הועלה, וההוצאה לא הופיעה בו. אולי שולם במזומן, בכרטיס אחר, או שזו כפילות.</p>
    ${list.slice(0, 8).map((t) => html`<div class="fxrow"><div class="n">${t.merchant}<small>${t.date.slice(8, 10)}/${t.date.slice(5, 7)} · ${methodLabel(methodById(t.payment_method_id))} · ${personName(ctx(), t.person_id)}</small></div>
      <div class="a num">${ils2(t.amount)}</div>
      ${w ? html`<div class="row" style="gap:2px"><button class="ghost" data-click="um-cash" data-id="${t.id}">שולם במזומן</button><button class="ghost" data-click="um-ok" data-id="${t.id}">בסדר</button><button class="ghost ${isArmed("um/" + t.id) ? "danger" : ""}" data-click="um-del" data-id="${t.id}">${isArmed("um/" + t.id) ? "למחוק?" : "כפילות"}</button></div>` : html`<span></span>`}</div>`)}
  </div>`;
});

overviewCards.push((m) => {
  const tx = txOf(ctx(), m);
  const withdrawn = tx.filter((t) => t.category === "משיכת מזומן").reduce((a, t) => a + t.amount, 0);
  const cashIds = new Set(S.methods.filter((x) => x.type === "cash").map((x) => x.id));
  const logged = tx.filter((t) => !isExcl(t) && t.payment_method_id && cashIds.has(t.payment_method_id)).reduce((a, t) => a + t.amount, 0);
  if (withdrawn <= 0 && logged <= 0) return html``;
  const gap = withdrawn - logged;
  return html`<div class="card"><div class="card-h"><h2>מזומן</h2></div>
    <div class="tiles"><div class="tile"><div class="l">נמשך מהכספומט</div><div class="v num">${ils(withdrawn)}</div></div>
      <div class="tile"><div class="l">הוצאות שנרשמו במזומן</div><div class="v num">${ils(logged)}</div></div></div>
    ${gap > 1 ? html`<p class="small"><b class="num">${ils(gap)}</b> במזומן בלי פירוט. אפשר להוסיף אותן ב"הוספה" עם "מזומן".</p>` : ""}
    <p class="muted small">משיכה מהכספומט היא העברה למזומן ולא נספרת כהוצאה. רק מה שנרשם במזומן נספר.</p></div>`;
});

overviewCards.push((m) => {
  const tx = txOf(ctx(), m).filter((t) => !isExcl(t));
  if (!tx.some((t) => t.payment_method_id)) return html``;
  const by = new Map<string, number>();
  for (const t of tx) by.set(t.payment_method_id ?? "", (by.get(t.payment_method_id ?? "") ?? 0) + t.amount);
  const rows = [...by.entries()].filter(([, a]) => Math.abs(a) > 0.005).sort((a, b) => b[1] - a[1]);
  const mx = Math.max(...rows.map((r) => r[1]), 1);
  const waitingN = tx.filter((t) => t.match_status === "awaiting_statement").length;
  return html`<div class="card"><div class="card-h"><h2>לפי אמצעי תשלום</h2>${waitingN ? html`<span class="muted small">${waitingN} ממתינות לפירוט</span>` : ""}</div>
    ${rows.map(([id, a]) => html`<div><div class="row between small"><span>${methodLabel(methodById(id))}</span><span class="num">${ils(a)}</span></div>
      <div class="bar"><span style="width:${Math.max(0, Math.min(100, (a / mx) * 100))}%"></span></div></div>`)}</div>`;
});

on("click", "um-cash", async (el) => {
  const cash = activeMethods().find((x) => x.type === "cash");
  try { await updateTx(el.dataset.id!, { payment_method_id: cash?.id ?? null, match_status: "none" }); flash("✓ עודכן: שולם במזומן", "ok"); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "um-ok", async (el) => {
  try { await updateTx(el.dataset.id!, { match_status: "none" }); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "um-del", async (el) => {
  if (!armed2("um/" + el.dataset.id, rerender)) return;
  try { await deleteTx(el.dataset.id!); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});

// ---------------------------------------------------- methods manager (Home)
const ISSUERS = ["מקס", "ישראכרט", "כאל", "אמריקן אקספרס", "דיינרס", "לאומי", "הפועלים", "דיסקונט", "מזרחי-טפחות", "הבינלאומי", "ירושלים", "וואן זירו", "מרכנתיל"];

homeCards.push(() => {
  const w = canWrite();
  const edit = methodById(S.extra.editPm);
  const used = (id: string) => S.tx.some((t) => t.payment_method_id === id) || S.fixed.some((f) => f.payment_method_id === id);
  // voucher methods (0014) are created and managed by the voucher wallet, not here
  const list = S.methods.filter((m) => m.type !== "voucher").sort((a, b) => Number(b.active) - Number(a.active) || a.sort - b.sort);
  const type: PmType = (S.extra.pmType as PmType) ?? edit?.type ?? "credit_card";
  const cardLike = type === "credit_card" || type === "debit_card";
  return html`<div class="card">
    <h2>אמצעי תשלום</h2>
    <p class="muted small">קבלה או הוצאה ששולמה בכרטיס מחכה לפירוט של אותו כרטיס, ואז שתיהן מתאחדות לשורה אחת — כך שום הוצאה לא נספרת פעמיים. מזומן נספר מיד. שומרים רק 4 ספרות אחרונות, אף פעם לא מספר כרטיס מלא.</p>
    <div>${list.map((m) => html`<div class="fxrow"><div class="n">${methodLabel(m)}${m.active ? "" : " (מוסתר)"}<small>${PM_TYPES[m.type]}${m.issuer ? " · " + m.issuer : ""}${m.person_id ? " · " + personName(ctx(), m.person_id) : ""}</small></div><span></span>
      ${w ? html`<div class="row" style="gap:2px"><button class="ghost" data-click="pm-edit" data-id="${m.id}">עריכה</button>${used(m.id)
        ? html`<button class="ghost" data-click="pm-toggle" data-id="${m.id}">${m.active ? "הסתרה" : "החזרה"}</button>`
        : html`<button class="ghost ${isArmed("pm/" + m.id) ? "danger" : ""}" data-click="pm-del" data-id="${m.id}" aria-label="מחיקה">${isArmed("pm/" + m.id) ? "למחוק?" : "✕"}</button>`}</div>` : html`<span></span>`}</div>`)}</div>
    ${w ? html`<h3>${edit ? "עריכת " + edit.label : "אמצעי תשלום חדש"}</h3>
    <form class="grid2" data-submit="pm-save">
      <label class="f">סוג<select id="pmType" data-change="pm-type">${(Object.keys(PM_TYPES) as PmType[]).filter((k) => k !== "voucher").map((k) => html`<option value="${k}" ${attr(k === type, "selected")}>${PM_TYPES[k]}</option>`)}</select></label>
      <label class="f">שם<input type="text" id="pmLabel" maxlength="40" required placeholder="${cardLike ? "למשל: המקס של נועה" : "למשל: חשבון הבנק"}" value="${edit?.label ?? ""}"></label>
      <label class="f">חברה / בנק<input type="text" id="pmIssuer" maxlength="30" list="pmIssuers" value="${edit?.issuer ?? ""}"><datalist id="pmIssuers">${ISSUERS.map((i) => html`<option value="${i}"></option>`)}</datalist></label>
      ${cardLike ? html`<label class="f">4 ספרות אחרונות (לא חובה)<input type="text" id="pmLast4" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off" value="${edit?.last4 ?? ""}"></label>` : ""}
      <label class="f">של מי<select id="pmPerson">${personOptionsHtml(edit?.person_id ?? null)}</select></label>
      <div class="row end" style="grid-column:1/-1">${edit ? html`<button type="button" class="ghost" data-click="pm-edit" data-id="">ביטול</button>` : ""}<button class="primary" type="submit">שמירה</button></div>
    </form>` : ""}
  </div>`;
});

on("change", "pm-type", (el) => { S.extra.pmType = (el as HTMLSelectElement).value; rerender(); });
on("click", "pm-edit", (el) => { S.extra.editPm = el.dataset.id || undefined; S.extra.pmType = undefined; rerender(); });
on("click", "pm-toggle", async (el) => {
  const m = methodById(el.dataset.id);
  if (!m) return;
  try { await savePaymentMethod({ id: m.id, active: !m.active }); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "pm-del", async (el) => {
  if (!armed2("pm/" + el.dataset.id, rerender)) return;
  try { await deletePaymentMethod(el.dataset.id!); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("submit", "pm-save", async () => {
  const v = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value ?? "").trim();
  const type = v("pmType") as PmType;
  const label = v("pmLabel");
  const last4 = v("pmLast4");
  if (!label) { flash("צריך לתת שם לאמצעי התשלום.", "err"); return; }
  if (last4 && !/^\d{4}$/.test(last4)) { flash("רק 4 הספרות האחרונות של הכרטיס.", "err"); return; }
  const edit = methodById(S.extra.editPm);
  try {
    await savePaymentMethod({
      id: edit?.id, type, label: label.slice(0, 40), issuer: v("pmIssuer").slice(0, 30),
      last4: type === "credit_card" || type === "debit_card" ? last4 || null : null, person_id: v("pmPerson") || null,
      sort: edit?.sort ?? (type === "cash" ? 1 : 10 + S.methods.length),
    });
    flash(`✓ נשמר: ${label}`, "ok");
    S.extra.editPm = undefined;
    S.extra.pmType = undefined;
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
