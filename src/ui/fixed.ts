// קבועות — the fixed-expense list and form (prototype) + an optional due day
// used for "upcoming bills" reminders.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { ils, ils2 } from "../lib/format.ts";
import { personName } from "../domain/calc.ts";
import { canWrite, ctx, flash, rerender, S } from "../state.ts";
import { deleteFixed, saveFixed } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { catOptions, personOptionsHtml } from "./common.ts";

/** Phase 2 (fixed-expense suggestions) renders above the list. */
export const fixedTop: (() => SafeHtml)[] = [];

export function renderFixed(): SafeHtml {
  const w = canWrite();
  const tot = S.fixed.reduce((a, f) => a + f.amount / (f.cycle || 1), 0);
  const edit = S.fixed.find((f) => f.id === S.editFx) ?? null;
  const c = ctx();
  return html`${fixedTop.map((f) => f())}
  <div class="card">
    <div class="card-h"><h2>ההוצאות הקבועות</h2><span class="muted small num">${S.fixed.length ? "כ-" + ils(tot) + " בחודש" : ""}</span></div>
    <p class="muted small">כל הוצאה כאן מזוהה אוטומטית בתנועות לפי מילת החיפוש, ובסקירה רואים אם היא ירדה החודש ובאיזה סכום.</p>
    <div>${S.fixed.length ? S.fixed.slice().sort((a, b) => b.amount - a.amount).map((f) => {
      const armed = isArmed("fx/" + f.id);
      return html`<div class="fxrow"><div class="n">${f.name}<small>${f.category} · מזוהה לפי "${f.keyword}"${f.person_id ? " · " + personName(c, f.person_id) : ""}${f.cycle === 2 ? " · כל חודשיים" : f.cycle === 12 ? " · שנתי" : ""}${f.due_day ? ` · יורד ב-${f.due_day} לחודש` : ""}</small></div>
        <div class="a num">${ils2(f.amount)}</div>
        ${w ? html`<div class="row" style="gap:2px"><button class="ghost" data-click="fx-edit" data-id="${f.id}">עריכה</button><button class="ghost ${armed ? "danger" : ""}" data-click="fx-del" data-id="${f.id}" aria-label="מחיקה">${armed ? "למחוק?" : "✕"}</button></div>` : html`<span></span>`}</div>`;
    }) : html`<p class="muted">עוד אין הוצאות קבועות.</p>`}</div>
  </div>
  ${w ? html`<div class="card">
    <h2>${edit ? "עריכת " + edit.name : "הוצאה קבועה חדשה"}</h2>
    <form class="grid2" data-submit="fx-save">
      <label class="f">שם<input type="text" id="xName" required maxlength="60" placeholder="ביטוח בריאות – הראל" value="${edit?.name ?? ""}"></label>
      <label class="f">סכום חודשי צפוי (₪)<input type="number" id="xAmt" step="0.01" inputmode="decimal" required value="${edit?.amount ?? ""}"></label>
      <label class="f">מילת חיפוש בפירוט<input type="text" id="xKey" required maxlength="40" placeholder="הראל" value="${edit?.keyword ?? ""}"></label>
      <label class="f">קטגוריה<select id="xCat">${catOptions(edit?.category ?? "ביטוחים", false)}</select></label>
      <label class="f">של מי<select id="xPerson"><option value="any">כל אחד</option>${personOptionsHtml(edit ? edit.person_id ?? "any" : "any")}</select></label>
      <label class="f">תדירות<select id="xCycle">
        <option value="1" ${attr(!edit || edit.cycle === 1, "selected")}>כל חודש</option>
        <option value="2" ${attr(edit?.cycle === 2, "selected")}>כל חודשיים</option>
        <option value="12" ${attr(edit?.cycle === 12, "selected")}>פעם בשנה</option></select></label>
      <label class="f">יום חיוב בחודש (לתזכורות, לא חובה)<input type="number" id="xDue" min="1" max="31" inputmode="numeric" value="${edit?.due_day ?? ""}"></label>
      <div class="row end" style="grid-column:1/-1">
        ${edit ? html`<button type="button" class="ghost" data-click="fx-edit" data-id="">ביטול</button>` : ""}
        <button class="primary" type="submit">שמירה</button>
      </div>
    </form>
  </div>` : ""}`;
}

on("click", "fx-edit", (el) => { S.editFx = el.dataset.id || null; rerender(); window.scrollTo({ top: document.body.scrollHeight }); });
on("click", "fx-del", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("fx/" + id, rerender)) return;
  try { await deleteFixed(id); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("submit", "fx-save", async () => {
  const val = (id: string) => ($(id) as HTMLInputElement).value;
  const a = parseFloat(val("xAmt"));
  const name = val("xName").trim(), keyword = val("xKey").trim();
  if (!name || !keyword || !isFinite(a)) { flash("צריך למלא שם, סכום ומילת חיפוש.", "err"); return; }
  const due = parseInt(val("xDue"), 10);
  const person = val("xPerson");
  try {
    await saveFixed({
      id: S.editFx ?? undefined, name, amount: Math.round(a * 100) / 100, keyword, category: val("xCat"),
      person_id: person === "any" || person === "" ? null : person, cycle: +val("xCycle") as 1 | 2 | 12,
      due_day: due >= 1 && due <= 31 ? due : null,
    });
    flash(`✓ נשמר: ${name}`, "ok");
    S.editFx = null;
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
