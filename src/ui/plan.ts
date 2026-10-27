// תכנון — category budgets, the annual/irregular expenses calendar, savings goals.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { HEB_M, ils, ils2, mLabel, mShort, today } from "../lib/format.ts";
import { CATS } from "../domain/categories.ts";
import { annualCalendar, budgetRows, goalProgress, yearReport } from "../domain/plan.ts";
import { exportYear } from "../importer.ts";
import { jar } from "./charts.ts";
import { art } from "./art.ts";
import { confetti } from "./motion.ts";
import { canWrite, ctx, flash, rerender, S, startDay } from "../state.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { P2 } from "../phase2.ts";

export function renderPlan(): SafeHtml {
  return html`${budgetsCard()}${yearCard()}${annualCard()}${goalsCard()}`;
}

// feature 3: 12 budget months by category, ending at the month on screen
function yearCard(): SafeHtml {
  const y = yearReport(ctx(), S.month);
  if (!y.rows.length) return html``;
  const st = startDay();
  const k = (n: number) => (n ? (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + "K" : Math.round(n).toString()) : "–");
  return html`<div class="card"><div class="card-h"><h2>דוח שנתי</h2><button class="ghost" data-click="year-xlsx">ייצוא ל-Excel</button></div>
    <p class="muted small">12 חודשים עד ${mLabel(S.month)}${st > 1 ? `, כל חודש מה-${st} בו` : ""}. סכומים בשקלים, בלי הכנסות והעברות.</p>
    <div class="yr" role="region" aria-label="דוח שנתי לפי קטגוריה" tabindex="0"><table>
      <thead><tr><th>קטגוריה</th>${y.months.map((m) => html`<th class="num">${mShort(m)}</th>`)}<th class="num">סה״כ</th></tr></thead>
      <tbody>${y.rows.map((r) => html`<tr><th>${r.category}</th>${r.byMonth.map((v) => html`<td class="num">${k(v)}</td>`)}<td class="num"><b>${ils(r.total)}</b></td></tr>`)}</tbody>
      <tfoot><tr><th>סה״כ</th>${y.totals.map((v) => html`<td class="num">${k(v)}</td>`)}<td class="num"><b>${ils(y.total)}</b></td></tr></tfoot>
    </table></div></div>`;
}
on("click", "year-xlsx", () => { exportYear(S.month).catch(() => flash("הייצוא נכשל", "err")); });

function budgetsCard(): SafeHtml {
  const w = canWrite();
  const rows = budgetRows(ctx(), P2().budgets, S.month);
  const used = new Set(rows.map((r) => r.category));
  return html`<div class="card"><h2>תקציב לפי קטגוריה</h2>
    <p class="muted small">מגדירים סכום חודשי לקטגוריה. ב-80% מקבלים אזהרה, וב-100% התראה שעברתם את התקציב.</p>
    ${rows.length ? rows.map((r) => html`<div><div class="row between small"><b>${r.category}</b><span class="num">${ils(r.spent)} / ${ils(r.amount)} · ${Math.round(r.pct)}%
        ${w ? html`<button class="ghost ${isArmed("bud/" + r.category) ? "danger" : ""}" data-click="bud-del" data-cat="${r.category}" aria-label="מחיקה">${isArmed("bud/" + r.category) ? "למחוק?" : "✕"}</button>` : ""}</span></div>
      <div class="bar ${r.level === "over" ? "over" : r.level === "warn" ? "warn" : ""}"><span style="width:${Math.min(100, r.pct)}%"></span></div></div>`) : html`<p class="muted">עוד אין תקציבים.</p>`}
    ${w ? html`<form class="grid2" data-submit="bud-save">
      <label class="f">קטגוריה<select id="budCat">${CATS.filter((c) => !used.has(c)).map((c) => html`<option>${c}</option>`)}</select></label>
      <label class="f">סכום לחודש (₪)<input type="number" id="budAmt" min="1" step="1" inputmode="numeric" required></label>
      <div class="row end" style="grid-column:1/-1"><button class="primary" type="submit">שמירה</button></div></form>` : ""}
  </div>`;
}

function annualCard(): SafeHtml {
  const w = canWrite();
  const list = annualCalendar(P2().annual, new Date());
  return html`<div class="card"><h2>הוצאות שנתיות ולא סדירות</h2>
    <p class="muted small">ביטוח רכב, ארנונה שנתית, מנויים שנתיים, טסט… מקבלים תזכורת לפני המועד.</p>
    ${list.length ? list.map((a) => html`<div class="fxrow"><div class="n">${a.name}<small>${a.next.getDate()} ב${HEB_M[a.next.getMonth()]} · תזכורת ${a.remind_days} ימים לפני</small></div>
      <div class="a num">${ils2(a.amount)}<small>${a.days === 0 ? "היום" : `בעוד ${a.days} ימים`}</small></div>
      ${w ? html`<button class="ghost ${isArmed("ann/" + a.id) ? "danger" : ""}" data-click="ann-del" data-id="${a.id}" aria-label="מחיקה">${isArmed("ann/" + a.id) ? "למחוק?" : "✕"}</button>` : html`<span></span>`}</div>`)
      : html`<p class="muted">עוד לא נוספו הוצאות שנתיות.</p>`}
    ${w ? html`<form class="grid2" data-submit="ann-save">
      <label class="f">שם<input type="text" id="annName" maxlength="60" required placeholder="ביטוח רכב"></label>
      <label class="f">סכום משוער (₪)<input type="number" id="annAmt" min="0" step="1" inputmode="numeric" required></label>
      <label class="f">חודש<select id="annMonth">${HEB_M.map((m, i) => html`<option value="${i + 1}">${m}</option>`)}</select></label>
      <label class="f">יום בחודש<input type="number" id="annDay" min="1" max="31" value="1" inputmode="numeric"></label>
      <label class="f">תזכורת<select id="annRemind"><option value="7">שבוע לפני</option><option value="14" selected>שבועיים לפני</option><option value="30">חודש לפני</option></select></label>
      <label class="f">קטגוריה<select id="annCat">${CATS.map((c) => html`<option ${attr(c === "ביטוחים", "selected")}>${c}</option>`)}</select></label>
      <div class="row end" style="grid-column:1/-1"><button class="primary" type="submit">הוספה</button></div></form>` : ""}
  </div>`;
}

function goalsCard(): SafeHtml {
  const w = canWrite();
  const p = P2();
  const goals = p.goals.filter((g) => !g.archived);
  return html`<div class="card"><h2>יעדי חיסכון</h2>
    ${goals.length ? goals.map((g) => {
      const pr = goalProgress(g, p.deposits, new Date());
      return html`<div class="tip"><div class="goal">${jar(pr.pct, g.id)}<div><div class="t"><b>${g.name}</b><span class="num">${ils(pr.saved)} / ${ils(g.target)}</span></div>
        <div class="num" style="font-size:22px;font-weight:700;color:var(--accent-deep)">${Math.round(pr.pct)}%</div>
        <div class="muted small">${pr.done ? "🎉 היעד הושג!" : `נשארו ${ils(pr.remaining)}`}${pr.perMonth ? ` · כדי להגיע בזמן: ${ils(pr.perMonth)} בחודש` : ""}</div></div></div>
        ${w ? html`<form class="row" style="flex-wrap:nowrap" data-submit="dep-save" data-id="${g.id}">
          <input type="number" name="amt" step="1" inputmode="decimal" placeholder="סכום (מינוס = משיכה)" aria-label="הפקדה">
          <button type="submit">הפקדה</button>
          <button type="button" class="ghost ${isArmed("goal/" + g.id) ? "danger" : ""}" data-click="goal-archive" data-id="${g.id}">${isArmed("goal/" + g.id) ? "לסגור?" : "סגירה"}</button></form>` : ""}
      </div>`;
    }) : html`<div class="empty">${art.goalsEmpty()}<p class="muted">עוד אין יעדים. למשל: חופשה, רכב, קרן חירום.</p></div>`}
    ${w ? html`<form class="grid2" data-submit="goal-save">
      <label class="f">יעד<input type="text" id="goalName" maxlength="60" required placeholder="חופשה משפחתית"></label>
      <label class="f">סכום היעד (₪)<input type="number" id="goalTarget" min="1" step="1" inputmode="numeric" required></label>
      <label class="f">עד תאריך (לא חובה)<input type="date" id="goalDate" min="${today()}"></label>
      <div class="row end" style="grid-column:1/-1;align-self:end"><button class="primary" type="submit">יעד חדש</button></div></form>` : ""}
  </div>`;
}

const fail = (e: unknown) => flash(dbMessage(e), "err");
const val = (id: string) => ($(id) as HTMLInputElement).value;

on("submit", "bud-save", async () => {
  const amount = Number(val("budAmt"));
  const category = val("budCat");
  if (!category || !(amount > 0)) return;
  const { error } = await sb.from("budgets").upsert({ household_id: S.hh, category, amount }, { onConflict: "household_id,category" });
  if (error) return fail(error);
  P2().budgets = [...P2().budgets.filter((b) => b.category !== category), { category, amount }];
  rerender();
});
on("click", "bud-del", async (el) => {
  const c = el.dataset.cat!;
  if (!armed2("bud/" + c, rerender)) return;
  const { error } = await sb.from("budgets").delete().eq("household_id", S.hh!).eq("category", c);
  if (error) return fail(error);
  P2().budgets = P2().budgets.filter((b) => b.category !== c);
  rerender();
});
on("submit", "ann-save", async () => {
  const row = {
    household_id: S.hh, name: val("annName").trim().slice(0, 60), amount: Number(val("annAmt")) || 0,
    due_month: Number(val("annMonth")), due_day: Math.min(31, Math.max(1, Number(val("annDay")) || 1)),
    remind_days: Number(val("annRemind")), category: val("annCat"),
  };
  if (!row.name) return;
  const { data, error } = await sb.from("annual_expenses").insert(row).select("*").single();
  if (error) return fail(error);
  P2().annual = [...P2().annual, { ...(data as any), amount: Number((data as any).amount) }];
  flash(`✓ נוסף: ${row.name}`, "ok");
  rerender();
});
on("click", "ann-del", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("ann/" + id, rerender)) return;
  const { error } = await sb.from("annual_expenses").delete().eq("id", id);
  if (error) return fail(error);
  P2().annual = P2().annual.filter((a) => a.id !== id);
  rerender();
});
on("submit", "goal-save", async () => {
  const row = { household_id: S.hh, name: val("goalName").trim().slice(0, 60), target: Number(val("goalTarget")), target_date: val("goalDate") || null };
  if (!row.name || !(row.target > 0)) return;
  const { data, error } = await sb.from("savings_goals").insert(row).select("*").single();
  if (error) return fail(error);
  P2().goals = [...P2().goals, { ...(data as any), target: Number((data as any).target) }];
  rerender();
});
on("submit", "dep-save", async (el) => {
  const amount = Math.round(Number(((el as HTMLFormElement).elements.namedItem("amt") as HTMLInputElement).value) * 100) / 100;
  if (!amount) return;
  const { data, error } = await sb.from("goal_deposits").insert({ household_id: S.hh, goal_id: el.dataset.id, amount }).select("id, goal_id, amount, date, note").single();
  if (error) return fail(error);
  const goal = P2().goals.find((g) => g.id === el.dataset.id);
  const was = goal ? goalProgress(goal, P2().deposits, new Date()).done : true;
  P2().deposits = [{ ...(data as any), amount: Number((data as any).amount) }, ...P2().deposits];
  if (goal && !was && goalProgress(goal, P2().deposits, new Date()).done) { confetti(); flash(`🎉 היעד "${goal.name}" הושג!`, "ok"); rerender(); return; }
  flash(amount > 0 ? `✓ הופקדו ${ils2(amount)}` : `✓ נמשכו ${ils2(-amount)}`, "ok");
  rerender();
});
on("click", "goal-archive", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("goal/" + id, rerender)) return;
  const { error } = await sb.from("savings_goals").update({ archived: true }).eq("id", id);
  if (error) return fail(error);
  P2().goals = P2().goals.map((g) => (g.id === id ? { ...g, archived: true } : g));
  rerender();
});
