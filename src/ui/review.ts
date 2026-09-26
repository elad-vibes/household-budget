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
import { deleteTx, insertTx, updateTx } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { banner, catOptions, personOptionsHtml } from "./common.ts";

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
    return html`<div class="card" style="padding:12px;background:var(--surface2)">
      <div class="card-h"><h3>${d.title}</h3><span class="chip grey">${personName(ctx(), P.personId)} · ${d.rows.length} שורות</span></div>
      ${check}${dups ? banner(`${dups} שורות כבר קיימות במערכת ולא סומנו לשמירה.`, "info") : ""}
      <div class="scroll"><table><thead><tr><th></th><th>תאריך</th><th>בית עסק</th><th>סכום</th><th>קטגוריה</th><th>קבוע</th></tr></thead><tbody>
      ${d.rows.map((r, ri) => html`<tr class="${r.dup ? "dup" : ""}">
        <td><input type="checkbox" data-change="rv-field" data-d="${di}" data-r="${ri}" data-f="keep" ${attr(r.keep, "checked")} aria-label="לשמור"></td>
        <td class="num">${ddmm(r.date)}</td>
        <td>${r.merchant}${r.note ? html`<div class="muted small">${r.note}</div>` : ""}${r.dup ? html`<div class="small" style="color:var(--warn)">כבר קיים</div>` : ""}</td>
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
on("click", "rv-cancel", () => { S.pending = null; S.extra.stStatus = null; rerender(); });
on("click", "rv-save", async () => {
  const P = S.pending;
  if (!P || S.busy) return;
  S.busy = true;
  rerender();
  let saved = 0;
  const months = new Set<string>();
  try {
    for (const d of P.docs) {
      const rows = d.rows.filter((r) => r.keep).map((r) => {
        months.add(r.month);
        return {
          date: r.date, month: r.month, merchant: r.merchant, amount: r.amount, category: r.category, is_fixed: r.fixed,
          note: r.note, person_id: P.personId, source: d.source, source_title: d.title, status: "saved" as const,
        };
      });
      if (rows.length) saved += (await insertTx(rows)).length;
    }
    S.pending = null;
    S.extra.stStatus = null;
    const ms = [...months].sort();
    if (ms.length) { S.month = ms[ms.length - 1]; S.monthTouched = true; }
    flash(`✓ נשמרו ${saved} תנועות.`, "ok");
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
    <div class="card-h"><h2>${list.length} קבלות מחכות לאישור</h2>${w ? html`<button class="primary" data-click="rr-all">לאשר הכול</button>` : ""}</div>
    <p class="muted small">Claude קרא את הקבלות. כדאי לבדוק סכום וקטגוריה לפני האישור. רק קבלות מאושרות נספרות בסקירה.</p>
    ${list.map((t) => html`<div class="txedit" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <label class="f">בית עסק<input type="text" maxlength="80" value="${t.merchant}" data-change="rr-field" data-id="${t.id}" data-f="merchant" ${attr(!w, "disabled")}></label>
      <label class="f">סכום<input type="number" step="0.01" inputmode="decimal" value="${t.amount}" data-change="rr-field" data-id="${t.id}" data-f="amount" ${attr(!w, "disabled")}></label>
      <label class="f">תאריך<input type="date" value="${t.date}" data-change="rr-field" data-id="${t.id}" data-f="date" ${attr(!w, "disabled")}></label>
      <label class="f">קטגוריה<select data-change="rr-field" data-id="${t.id}" data-f="category" ${attr(!w, "disabled")}>${catOptions(t.category)}</select></label>
      <label class="f">של מי<select data-change="rr-field" data-id="${t.id}" data-f="person_id" ${attr(!w, "disabled")}>${personOptionsHtml(t.person_id)}</select></label>
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
  else patch[f] = v.trim().slice(0, 80) || "קבלה";
  try { await updateTx(id, patch); } catch (e) { flash(dbMessage(e), "err"); }
});
on("click", "rr-ok", async (el) => {
  try { await updateTx(el.dataset.id!, { status: "saved" }); rerender(); } catch (e) { flash(dbMessage(e), "err"); }
});
on("click", "rr-del", async (el) => {
  try { await deleteTx(el.dataset.id!); rerender(); } catch (e) { flash(dbMessage(e), "err"); }
});
on("click", "rr-all", async () => {
  try {
    for (const t of reviewTx(ctx())) await updateTx(t.id, { status: "saved" });
    flash("✓ כל הקבלות אושרו.", "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
