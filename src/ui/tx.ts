// תנועות — month list with filters (prototype), tap to edit, two-tap delete,
// and the receipts waiting for approval on top.
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { ddmm, ils } from "../lib/format.ts";
import { isExcl, isFixed, personName, personOptions, txOf } from "../domain/calc.ts";
import { canWrite, ctx, flash, rerender, S } from "../state.ts";
import { deleteTx, updateTx } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { catOptions, personOptionsHtml } from "./common.ts";
import { renderReceiptReview } from "./review.ts";

export function renderTx(): SafeHtml {
  const c = ctx();
  const tx = txOf(c, S.month);
  const cs = [...new Set(tx.map((t) => t.category))].sort();
  if (S.fCat !== "all" && !S.fCat.startsWith("__") && !cs.includes(S.fCat)) S.fCat = "all";
  let list = tx.filter((t) => S.fPerson === "all" || (t.person_id ?? "") === S.fPerson);
  if (S.fCat === "__fixed") list = list.filter((t) => isFixed(c, t));
  else if (S.fCat === "__var") list = list.filter((t) => !isFixed(c, t));
  else if (S.fCat !== "all") list = list.filter((t) => t.category === S.fCat);
  list.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  const sum = list.filter((t) => !isExcl(t)).reduce((a, t) => a + t.amount, 0);
  const editing: string | null = S.extra.editTx ?? null;
  const w = canWrite();

  const rows: SafeHtml[] = [];
  let last = "";
  for (const t of list) {
    if (t.date !== last) {
      rows.push(html`<div class="txday num">${ddmm(t.date)}${t.date.slice(0, 7) !== S.month ? "/" + t.date.slice(2, 4) : ""}</div>`);
      last = t.date;
    }
    const armed = isArmed("tx/" + t.id);
    rows.push(html`<div class="tx">
      <div class="m" data-click="${w ? "tx-edit" : ""}" data-id="${t.id}">${t.merchant}<small>${t.category} · ${personName(c, t.person_id)}${t.note ? " · " + t.note : ""}</small></div>
      <div class="row" style="gap:6px">${isExcl(t) ? html`<span class="chip grey">לא נספר</span>` : isFixed(c, t) ? html`<span class="chip fx">קבוע</span>` : ""}<span class="a num ${t.amount < 0 ? "neg" : ""}">${ils(t.amount, 2)}</span></div>
      ${w ? html`<button class="ghost ${armed ? "danger" : ""}" data-click="tx-del" data-id="${t.id}" aria-label="מחיקה">${armed ? "למחוק?" : "✕"}</button>` : html`<span></span>`}
      ${editing === t.id ? html`<form class="txedit" data-submit="tx-save" data-id="${t.id}">
        <label class="f">בית עסק<input type="text" id="eMerchant" maxlength="80" value="${t.merchant}"></label>
        <label class="f">סכום<input type="number" id="eAmount" step="0.01" inputmode="decimal" value="${t.amount}"></label>
        <label class="f">קטגוריה<select id="eCat">${catOptions(t.category)}</select></label>
        <label class="f">של מי<select id="ePerson">${personOptionsHtml(t.person_id)}</select></label>
        <label class="chk"><input type="checkbox" id="eFixed" ${attr(t.is_fixed, "checked")}> הוצאה קבועה</label>
        <div class="row end"><button type="button" class="ghost" data-click="tx-edit" data-id="">ביטול</button><button class="primary" type="submit">שמירה</button></div>
      </form>` : ""}
    </div>`);
  }

  return html`${renderReceiptReview()}
  <div class="card">
    <div class="card-h"><h2>תנועות החודש</h2><span class="muted small num">${list.length} תנועות · ${ils(sum, 2)}</span></div>
    <div class="grid2">
      <label class="f">של מי<select data-change="f-person"><option value="all">כולם</option>${personOptions(c).map(([k, n]) => html`<option value="${k}" ${attr(S.fPerson === k, "selected")}>${n}</option>`)}</select></label>
      <label class="f">קטגוריה<select data-change="f-cat"><option value="all">הכול</option><option value="__fixed" ${attr(S.fCat === "__fixed", "selected")}>רק קבועות</option><option value="__var" ${attr(S.fCat === "__var", "selected")}>רק משתנות</option>${cs.map((k) => html`<option ${attr(S.fCat === k, "selected")}>${k}</option>`)}</select></label>
    </div>
    <div>${rows.length ? rows : html`<p class="muted">אין תנועות להצגה.</p>`}</div>
  </div>`;
}

on("change", "f-person", (el) => { S.fPerson = (el as HTMLSelectElement).value; rerender(); });
on("change", "f-cat", (el) => { S.fCat = (el as HTMLSelectElement).value; rerender(); });
on("click", "tx-edit", (el) => { S.extra.editTx = el.dataset.id || null; rerender(); });
on("click", "tx-del", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("tx/" + id, rerender)) return;
  try { await deleteTx(id); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("submit", "tx-save", async (el) => {
  const id = el.dataset.id!;
  const v = (sel: string) => (el.querySelector(sel) as HTMLInputElement).value;
  const amount = parseFloat(v("#eAmount"));
  if (!isFinite(amount) || amount === 0 || !v("#eMerchant").trim()) { flash("צריך סכום ותיאור.", "err"); return; }
  try {
    await updateTx(id, {
      merchant: v("#eMerchant").trim().slice(0, 80), amount: Math.round(amount * 100) / 100, category: v("#eCat"),
      person_id: v("#ePerson") || null, is_fixed: (el.querySelector("#eFixed") as HTMLInputElement).checked,
    });
    S.extra.editTx = null;
    flash("✓ נשמר", "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
