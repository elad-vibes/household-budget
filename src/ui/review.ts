// Review screens:
//   * imported / extracted statement rows (edit category/fixed, uncheck rows,
//     duplicate detection, "sum of rows matches statement total")
//   * parsed receipts waiting for approval (status 'review')
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { ddmm, ils } from "../lib/format.ts";
import { EXCL } from "../domain/categories.ts";
import { personName, reviewTx } from "../domain/calc.ts";
import { canWrite, ctx, flash, rerender, S } from "../state.ts";
import { deleteTx, updateTx } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { banner, catOptions, personOptionsHtml } from "./common.ts";
import { draftMatch, matchSummary, methodById, methodLabel, methodSelect, saveDraftDoc, settle, waitingById } from "../payments.ts";
import type { Tx } from "../domain/types.ts";
import { awaitsStatement, detectMethod, initialStatus } from "../domain/match.ts";

const excl = (c: string) => (EXCL as readonly string[]).includes(c);

export function renderReview(): SafeHtml {
  const P = S.pending;
  if (!P) return html``;
  return html`${P.docs.map((d, di) => {
    const kept = d.rows.filter((r) => r.keep);
    const sumAll = d.rows.filter((r) => !excl(r.category)).reduce((a, r) => a + r.amount, 0);
    const sumKept = kept.filter((r) => !excl(r.category)).reduce((a, r) => a + r.amount, 0);
    let check: SafeHtml | string = "";
    if (d.statementTotal != null) {
      const ok = Math.abs(sumAll - d.statementTotal) < 1;
      check = banner(ok ? `✓ סכום השורות (${ils(sumAll, 2)}) תואם לסה"כ במסמך.` : `סכום השורות ${ils(sumAll, 2)} לעומת ${ils(d.statementTotal, 2)} במסמך. כדאי לעבור על השורות לפני שמירה.`, ok ? "ok" : "warn");
    }
    const dups = d.rows.filter((r) => r.dup).length;
    const res = draftMatch(d);
    const summary = res ? matchSummary(res, d) : "";
    const merged = new Set(res?.merges.map((m) => m.rowKey) ?? []);
    const stMethods = S.methods.filter((m) => (m.active || m.id === d.methodId) && awaitsStatement(m.type));
    return html`<div class="card" style="padding:12px;background:var(--surface2)">
      <div class="card-h"><h3>${d.title}</h3><span class="chip grey">${personName(ctx(), P.personId)} · ${d.rows.length} שורות</span></div>
      <label class="f">הפירוט הזה של<select data-change="rv-method" data-d="${di}">
        <option value="" ${attr(!d.methodId, "selected")}>בחירה…</option>
        ${stMethods.map((m) => html`<option value="${m.id}" ${attr(m.id === d.methodId, "selected")}>${methodLabel(m)}</option>`)}
        <option value="none" ${attr(d.methodId === "none", "selected")}>בלי שיוך (לא להתאים קבלות)</option></select></label>
      ${!d.methodId ? banner("באיזה כרטיס או חשבון הפירוט הזה? כך הוצאות שכבר נרשמו מקבלות לא ייספרו פעמיים. (אפשר להוסיף כרטיס בהבית → אמצעי תשלום)", "warn") : ""}
      ${summary ? banner(`✓ ${summary}.`, "ok") : ""}
      ${res?.ambiguous.length ? html`<div class="banner info"><b>צריך את העזרה שלך:</b> ${res.ambiguous.length === 1 ? "שורה אחת בפירוט דומה" : `${res.ambiguous.length} שורות בפירוט דומות`} להוצאה שכבר נרשמה. האם זו אותה קנייה?
        ${res.ambiguous.map((a) => {
          const r = d.rows.find((x) => x.id === a.rowKey)!;
          return html`<label class="f" style="margin-top:8px">${r.merchant} · ${ils(r.amount, 2)} · ${ddmm(r.date)}<select data-change="rv-choice" data-d="${di}" data-r="${a.rowKey}">
            <option value="">לא, זו הוצאה אחרת</option>
            ${a.candidates.map((c) => { const t = waitingById(c.itemId); return t ? html`<option value="${c.itemId}" ${attr(d.choices[a.rowKey] === c.itemId, "selected")}>כן: ${t.merchant} · ${ils(t.amount, 2)} · ${ddmm(t.date)}</option>` : ""; })}
          </select></label>`;
        })}</div>` : ""}
      ${check}${dups ? banner(`${dups} שורות כבר קיימות במערכת ולא סומנו לשמירה.`, "info") : ""}
      <div class="scroll"><table><thead><tr><th></th><th>תאריך</th><th>בית עסק</th><th>סכום</th><th>קטגוריה</th><th>קבוע</th></tr></thead><tbody>
      ${d.rows.map((r, ri) => html`<tr class="${r.dup ? "dup" : ""}">
        <td><input type="checkbox" data-change="rv-field" data-d="${di}" data-r="${ri}" data-f="keep" ${attr(r.keep, "checked")} aria-label="לשמור"></td>
        <td class="num">${ddmm(r.date)}</td>
        <td>${r.merchant}${r.note ? html`<div class="muted small">${r.note}</div>` : ""}${r.dup ? html`<div class="small" style="color:var(--warn)">כבר קיים</div>` : ""}${merged.has(r.id) || (d.choices[r.id] && res?.ambiguous.some((a) => a.rowKey === r.id)) ? html`<div class="small" style="color:var(--ok)">מתאחד עם הוצאה שנרשמה</div>` : ""}</td>
        <td class="num" style="font-weight:700">${ils(r.amount, 2)}</td>
        <td><select data-change="rv-field" data-d="${di}" data-r="${ri}" data-f="category" aria-label="קטגוריה">${catOptions(r.category)}</select></td>
        <td><input type="checkbox" data-change="rv-field" data-d="${di}" data-r="${ri}" data-f="fixed" ${attr(r.fixed, "checked")} aria-label="קבוע"></td>
      </tr>`)}
      </tbody></table></div>
      <div class="muted small">מסומנות לשמירה: ${kept.length} שורות · ${ils(sumKept, 2)} בהוצאות</div>
    </div>`;
  })}
  <div class="row end"><button class="ghost" data-click="rv-cancel">ביטול</button><button class="primary" data-click="rv-save" ${attr(S.busy, "disabled")}>שמירה</button></div>`;
}

on("change", "rv-field", (el) => {
  const P = S.pending;
  if (!P) return;
  const r = P.docs[+el.dataset.d!].rows[+el.dataset.r!];
  const f = el.dataset.f!;
  if (f === "keep") r.keep = (el as HTMLInputElement).checked;
  else if (f === "fixed") r.fixed = (el as HTMLInputElement).checked;
  else if (f === "category") r.category = (el as HTMLSelectElement).value;
  if (f !== "fixed") rerender();
});
on("change", "rv-method", (el) => {
  const d = S.pending?.docs[+el.dataset.d!];
  if (!d) return;
  d.methodId = (el as HTMLSelectElement).value;
  d.choices = {};
  rerender();
});
on("change", "rv-choice", (el) => {
  const d = S.pending?.docs[+el.dataset.d!];
  if (!d) return;
  d.choices[el.dataset.r!] = (el as HTMLSelectElement).value;
  rerender();
});
on("click", "rv-cancel", () => { S.pending = null; S.extra.stStatus = null; rerender(); });
on("click", "rv-save", async () => {
  const P = S.pending;
  if (!P || S.busy) return;
  if (P.docs.some((d) => !d.methodId)) { flash("צריך לבחור לכל פירוט של איזה כרטיס או חשבון הוא.", "err"); return; }
  S.busy = true;
  rerender();
  let saved = 0, merged = 0, unmatched = 0;
  const months = new Set<string>();
  try {
    for (const d of P.docs) {
      d.rows.filter((r) => r.keep).forEach((r) => months.add(r.month));
      const r = await saveDraftDoc(d, P.personId);
      saved += r.inserted;
      merged += r.merged;
      unmatched += r.unmatched;
    }
    S.pending = null;
    S.extra.stStatus = null;
    const ms = [...months].sort();
    if (ms.length) { S.month = ms[ms.length - 1]; S.monthTouched = true; }
    flash(`✓ נשמרו ${saved} תנועות${merged ? ` · ${merged === 1 ? "קבלה אחת הותאמה" : `${merged} קבלות הותאמו`} לפירוט` : ""}${unmatched ? ` · ${unmatched} לא נמצאו (ב"לבדוק")` : ""}.`, "ok");
  } catch (e) {
    flash(dbMessage(e), "err");
  } finally {
    S.busy = false;
    rerender();
  }
});

// ------------------------------------------------------ receipts to approve
export function renderReceiptReview(): SafeHtml {
  const list = reviewTx(ctx()).sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return html``;
  const w = canWrite();
  return html`<div class="card" style="border-color:var(--accent)">
    <div class="card-h"><h2>${list.length === 1 ? "קבלה אחת מחכה לאישור" : `${list.length} קבלות מחכות לאישור`}</h2>${w ? html`<button class="primary" data-click="rr-all">לאשר הכול</button>` : ""}</div>
    <p class="muted small">Claude קרא את הקבלות. כדאי לבדוק סכום וקטגוריה לפני האישור. רק קבלות מאושרות נספרות בסקירה.</p>
    ${list.map((t) => html`<div class="txedit" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <label class="f">בית עסק<input type="text" maxlength="80" value="${t.merchant}" data-change="rr-field" data-id="${t.id}" data-f="merchant" ${attr(!w, "disabled")}></label>
      <label class="f">סכום<input type="number" step="0.01" inputmode="decimal" value="${t.amount}" data-change="rr-field" data-id="${t.id}" data-f="amount" ${attr(!w, "disabled")}></label>
      <label class="f">תאריך<input type="date" value="${t.date}" data-change="rr-field" data-id="${t.id}" data-f="date" ${attr(!w, "disabled")}></label>
      <label class="f">קטגוריה<select data-change="rr-field" data-id="${t.id}" data-f="category" ${attr(!w, "disabled")}>${catOptions(t.category)}</select></label>
      <label class="f">של מי<select data-change="rr-field" data-id="${t.id}" data-f="person_id" ${attr(!w, "disabled")}>${personOptionsHtml(t.person_id)}</select></label>
      <label class="f">איך שולם${methodSelect("rrPm-" + t.id, receiptMethod(t), { change: "rr-field", id: t.id, f: "payment_method_id", disabled: w ? "" : "1" })}${t.payment_hint ? html`<small class="muted">בקבלה: ${t.payment_hint}</small>` : ""}</label>
      ${w ? html`<div class="row end" style="grid-column:1/-1"><button class="ghost danger" data-click="rr-del" data-id="${t.id}">מחיקה</button><button class="primary" data-click="rr-ok" data-id="${t.id}">אישור</button></div>` : ""}
    </div>`)}
  </div>`;
}

on("change", "rr-field", async (el) => {
  const id = el.dataset.id!, f = el.dataset.f!;
  const v = (el as HTMLInputElement).value;
  const patch: Record<string, unknown> = {};
  if (f === "amount") { const n = parseFloat(v); if (!isFinite(n) || n === 0) return; patch.amount = Math.round(n * 100) / 100; }
  else if (f === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return; patch.date = v; patch.month = v.slice(0, 7); }
  else if (f === "person_id") patch.person_id = v || null;
  else if (f === "payment_method_id") patch.payment_method_id = v || null;
  else patch[f] = v.trim().slice(0, 80) || "קבלה";
  try { await updateTx(id, patch); } catch (e) { flash(dbMessage(e), "err"); }
});

/** The receipt's method: chosen, or guessed from what the receipt says ("אשראי ****1234"). */
function receiptMethod(t: Tx): string | null {
  return t.payment_method_id ?? detectMethod(t.payment_hint ?? "", S.methods)?.id ?? null;
}
/** Approve one receipt: cash is counted now, a card waits for (or merges into) its statement. */
async function approve(t: Tx): Promise<string | null> {
  const pm = receiptMethod(t);
  await updateTx(t.id, { status: "saved", payment_method_id: pm, match_status: initialStatus(methodById(pm)) });
  const saved = S.tx.find((x) => x.id === t.id);
  return saved ? settle(saved) : null;
}
on("click", "rr-ok", async (el) => {
  const t = S.tx.find((x) => x.id === el.dataset.id);
  if (!t) return;
  try { const msg = await approve(t); if (msg) flash("✓ " + msg, "ok"); rerender(); } catch (e) { flash(dbMessage(e), "err"); }
});
on("click", "rr-del", async (el) => {
  try { await deleteTx(el.dataset.id!); rerender(); } catch (e) { flash(dbMessage(e), "err"); }
});
on("click", "rr-all", async () => {
  try {
    for (const t of reviewTx(ctx())) await approve(t);
    flash("✓ כל הקבלות אושרו.", "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
