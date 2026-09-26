// סקירה — ported from the prototype's renderOverview (+ review banner and
// Phase 2 cards that register themselves in overviewCards).
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { addM, fmtDateTime, HEB_M, ils, ils2, mLabel, mShort } from "../lib/format.ts";
import {
  fixedStatus, isExcl, isFixed, localTips, monthSummaryText, personColor, personName, reviewTx, subsOf, sumM, txOf,
} from "../domain/calc.ts";
import { canWrite, ctx, flash, rerender, S } from "../state.ts";
import { fn } from "../data.ts";
import { banner, linkHtml } from "./common.ts";
import type { AnalysisData } from "../domain/types.ts";
import { catColor, catIcon, tipIcon } from "./cat.ts";
import { donut, sparkline } from "./charts.ts";
import { art } from "./art.ts";
import { curMonth } from "../lib/format.ts";

/** Phase 2 modules push extra cards here (budgets, upcoming bills, suggestions). */
export const overviewCards: ((m: string) => SafeHtml)[] = [];

export function renderOverview(): SafeHtml {
  const m = S.month;
  const c = ctx();
  const s = sumM(c, m), p = sumM(c, addM(m, -1));
  const tx = txOf(c, m).filter((x) => !isExcl(x));
  const pending = reviewTx(c).length;
  const reviewBanner = pending
    ? banner(html`<b>${pending === 1 ? "קבלה אחת מחכה לאישור." : `${pending} קבלות מחכות לאישור.`}</b> <button data-click="go" data-to="tx">לאישור</button>`, "info")
    : html``;
  if (!tx.length) {
    return html`${reviewBanner}
      <div class="card herocard empty">${art.noTx()}<h2>${mLabel(m)}</h2>
        <p class="muted">עוד אין הוצאות לחודש הזה. אפשר להעלות פירוט אשראי, יצוא מהבנק או לצלם קבלה בלשונית "הוספה".</p>
        ${canWrite() ? html`<div><button class="primary" data-click="go" data-to="add">להוספת הוצאות</button></div>` : ""}
      </div>
      ${overviewCards.map((f) => f(m))}
      ${trendCard(m)}`;
  }
  let delta: SafeHtml | string = "";
  if (p.total > 0) {
    const d = ((s.total - p.total) / p.total) * 100;
    delta = html`<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d))}% מול ${HEB_M[+addM(m, -1).split("-")[1] - 1]}</span>`;
  }
  const byP: Record<string, number> = {};
  for (const x of tx) byP[x.person_id ?? ""] = (byP[x.person_id ?? ""] || 0) + x.amount;
  const keys = Object.keys(byP);
  const cats: Record<string, { fx: number; vr: number; n: number }> = {};
  for (const x of tx) {
    const k = cats[x.category] || (cats[x.category] = { fx: 0, vr: 0, n: 0 });
    if (isFixed(c, x)) k.fx += x.amount;
    else k.vr += x.amount;
    k.n++;
  }
  const rows = Object.entries(cats).map(([k, v]) => [k, v, v.fx + v.vr] as const).filter((r) => Math.abs(r[2]) > 0.005).sort((a, b) => b[2] - a[2]);
  const mx = Math.max(...rows.map((r) => r[2]), 1);
  const spark: number[] = [];
  for (let i = 5; i >= 0; i--) spark.push(sumM(c, addM(m, -i)).total);
  const saved = m < curMonth() && p.total > 0 && s.total < p.total;

  return html`${reviewBanner}
  <div class="card herocard">
    <div class="herorow"><div class="hero"><span class="big num" data-countup="${Math.round(s.total)}" data-key="hero:${m}">${ils(s.total)}</span>${delta}</div>${sparkline(spark)}</div>
    <div class="muted small">סך ההוצאות ב${mLabel(m)} · ${s.count} תנועות${s.inc ? ` · הכנסות ${ils(s.inc)}` : ""}</div>
    <div class="tiles">
      <div class="tile"><div class="l"><i class="dot" style="background:var(--fixed)"></i>קבועות</div><div class="v num">${ils(s.fx)}</div><div class="muted small">${s.total ? Math.round((s.fx / s.total) * 100) : 0}% מההוצאות</div></div>
      <div class="tile"><div class="l"><i class="dot" style="background:var(--var)"></i>משתנות</div><div class="v num">${ils(s.vr)}</div><div class="muted small">${p.vr ? (s.vr > p.vr ? "▲ " : "▼ ") + ils(Math.abs(s.vr - p.vr)) + " מהחודש הקודם" : "אין חודש קודם להשוואה"}</div></div>
      ${s.inc ? html`<div class="tile"><div class="l">יתרה (הכנסות פחות הוצאות)</div><div class="v num" style="color:${s.inc - s.total >= 0 ? "var(--ok)" : "var(--danger)"}">${ils(s.inc - s.total)}</div><div class="muted small">לפי מה שהועלה</div></div>` : ""}
    </div>
    ${keys.length > 1
      ? html`<div><div class="split">${keys.filter((k) => byP[k] > 0).map((k) => html`<span style="width:${(byP[k] / s.total) * 100}%;background:${personColor(c, k || null)}"></span>`)}</div>
          <div class="legend" style="margin-top:8px">${keys.map((k) => html`<span><i class="dot" style="background:${personColor(c, k || null)}"></i>${personName(c, k || null)} <b class="num">${ils(byP[k])}</b></span>`)}</div></div>`
      : html`<div class="legend">${keys.map((k) => html`<span><i class="dot" style="background:${personColor(c, k || null)}"></i>${personName(c, k || null)} <b class="num">${ils(byP[k])}</b></span>`)}</div>`}
  </div>
  ${saved ? html`<div class="card empty">${art.success()}<h2>חודש חסכוני</h2><p class="muted">ב${mLabel(m)} יצא ${ils(p.total - s.total)} פחות מהחודש שלפניו. כל הכבוד!</p></div>` : ""}
  ${overviewCards.map((f) => f(m))}
  <div class="card" id="anCard">
    <div class="card-h"><h2>ניתוח והמלצות</h2>
      ${canWrite() ? html`<button class="primary" data-click="analyze" ${attr(S.anBusy, "disabled")}>${S.analyses[m] ? "ניתוח מחדש" : "לנתח את החודש"}</button>` : ""}
    </div>
    <div>${analysisHtml(m)}</div>
  </div>
  <div class="card">
    <div class="card-h"><h2>לאן הלך הכסף</h2><div class="legend"><span><i class="dot" style="background:var(--fixed)"></i>קבוע</span><span><i class="dot" style="background:var(--var)"></i>משתנה</span></div></div>
    <div class="donutwrap">${donut(rows.map(([k, , t]) => ({ key: k, value: t, color: catColor(k) })), ils(s.total), "לחיצה פותחת")}
      <div class="dlegend">${rows.slice(0, 6).map(([k, , t]) => html`<button data-click="cat-go" data-cat="${k}"><i class="dot" style="background:${catColor(k)}"></i><span class="nm">${k}</span><b class="num">${Math.round((t / s.total) * 100)}%</b></button>`)}</div></div>
    <div>${rows.map(([k, v, t]) => html`<button class="catrow as-btn" data-click="cat-go" data-cat="${k}" aria-label="${k}: ${ils(t)} — לתנועות">${catIcon(k, "s")}<div class="name">${k}<small>${v.n} תנועות</small></div><div class="track">${v.fx > 0 ? html`<span style="width:${(v.fx / mx) * 100}%;background:var(--fixed)"></span>` : ""}${v.vr > 0 ? html`<span style="width:${(v.vr / mx) * 100}%;background:var(--var)"></span>` : ""}</div><div class="amt num">${ils(t)}<small>${Math.round((t / s.total) * 100)}%</small></div></button>`)}</div>
  </div>
  ${subsCard(m)}
  ${fixedStatusCard(m)}
  ${trendCard(m)}`;
}

function analysisHtml(m: string): SafeHtml {
  if (S.anBusy) return html`<div class="skel" aria-busy="true"><p class="muted small">Claude עובר על החודש… זה לוקח בערך חצי דקה.</p><div class="skel-line" style="width:90%"></div><div class="skel-line" style="width:75%"></div><div class="skel-line" style="width:82%"></div></div>`;
  const an = S.analyses[m];
  const d: AnalysisData | null = an?.data ?? localTips(ctx(), m);
  if (!d) return html`<p class="muted">Claude יעבור על ההוצאות של החודש, ישווה לחודשים קודמים ויציע איפה אפשר לחסוך, עם קישורים לאתרי השוואה בישראל. הניתוח נשמר, וכל בני הבית רואים אותו.</p>`;
  const tips = d.tips ?? [];
  const totalSave = tips.reduce((a, t) => a + (Number(t.save) || 0), 0);
  return html`<div class="an-sec"><h3>תמונת מצב</h3><p>${d.status}</p></div>
    ${d.changes ? html`<div class="an-sec"><h3>מה השתנה</h3><p>${d.changes}</p></div>` : ""}
    ${tips.length ? html`<div class="an-sec"><div class="card-h"><h3>איפה אפשר לחסוך</h3>${totalSave ? html`<span class="chip save">פוטנציאל: עד ${ils(totalSave)} בחודש</span>` : ""}</div>
      ${tips.map((t) => html`<div class="tip"><div class="t">${tipIcon(t.title)}<b>${t.title}</b>${t.save ? html`<span class="chip save">עד ${ils(+t.save)} בחודש</span>` : ""}</div><p>${t.text}</p>${linkHtml(t.links)}</div>`)}</div>` : ""}
    ${(d.checks ?? []).length ? html`<div class="an-sec"><h3>לבדוק</h3><ul class="plain">${d.checks.map((c) => html`<li>${c}</li>`)}</ul>${d.local ? linkHtml(["itur"]) : ""}</div>` : ""}
    ${d.local
      ? html`<div class="muted small">אלה המלצות אוטומטיות לפי כללים קבועים.${canWrite() ? " הכפתור למעלה מבקש ניתוח מותאם אישית מ-Claude." : ""}</div>`
      : an?.created_at ? html`<div class="muted small">נוצר ${fmtDateTime(an.created_at)}</div>` : ""}`;
}

function subsCard(m: string): SafeHtml {
  const subs = subsOf(ctx(), m);
  if (!subs.length) return html``;
  const tot = subs.reduce((a, x) => a + x.amount, 0);
  return html`<div class="card"><div class="card-h"><h2>מנויים ותוכן</h2><span class="muted small num">${ils2(tot)} החודש · ${ils(tot * 12)} בשנה</span></div>
    <div>${subs.map((x) => html`<div class="fxrow"><div class="n">${x.name}<small>${x.n} חיובים החודש</small></div><div class="a num">${ils2(x.amount)}</div><span></span></div>`)}</div>
    <p class="small muted">כדאי לבדוק כל כמה חודשים אם באמת צופים או משתמשים בכל אחד. אפשר לבטל ולחדש לחודש אחד כשיוצאת סדרה, לעבור לתוכנית זולה יותר, או לבדוק אם ספק הסלולר או הטלוויזיה נותן את השירות בחבילה.</p>
    ${linkHtml([...new Set(subs.flatMap((x) => x.links))])}</div>`;
}

function fixedStatusCard(m: string): SafeHtml {
  const c = ctx();
  if (!S.fixed.length) {
    return html`<div class="card"><h2>הקבועות החודש</h2><p class="muted small">עוד לא הוגדרו הוצאות קבועות.</p>${canWrite() ? html`<div><button data-click="go" data-to="fixed">להגדרת קבועות</button></div>` : ""}</div>`;
  }
  const rows = S.fixed.slice().sort((a, b) => b.amount - a.amount).map((f) => {
    const st = fixedStatus(c, f, m);
    const chip = st.kind === "notthis" ? html`<span class="chip grey">לא החודש</span>`
      : st.kind === "miss" ? html`<span class="chip miss">לא הופיע</span>`
      : st.kind === "ok" ? html`<span class="chip ok">כרגיל</span>`
      : html`<span class="chip warn">${st.kind === "high" ? "גבוה" : "נמוך"} ב-${ils(st.diff)}</span>`;
    return html`<div class="fxrow"><div class="n">${f.name}<small>${f.category}${f.cycle === 2 ? " · כל חודשיים" : f.cycle === 12 ? " · שנתי" : ""}</small></div><div class="a num">${st.actual ? ils2(st.actual) : "—"}<small>צפוי ${ils2(f.amount)}</small></div>${chip}</div>`;
  });
  return html`<div class="card"><div class="card-h"><h2>הקבועות החודש</h2>${canWrite() ? html`<button class="ghost" data-click="go" data-to="fixed">עריכה</button>` : ""}</div><div>${rows}</div></div>`;
}

function trendCard(m: string): SafeHtml {
  const ms: string[] = [];
  for (let i = 5; i >= 0; i--) ms.push(addM(m, -i));
  const data = ms.map((x) => [x, sumM(ctx(), x)] as const);
  const mx = Math.max(...data.map((d) => d[1].total), 1);
  if (!data.some((d) => d[1].total > 0)) return html``;
  return html`<div class="card"><div class="card-h"><h2>חצי שנה אחרונה</h2><span class="muted small">לחיצה על חודש פותחת אותו</span></div>
    <div class="trend">${data.map(([x, s]) => html`<button class="col ${x === m ? "cur" : ""}" data-click="month" data-m="${x}" aria-label="${mLabel(x)}: ${ils(s.total)}"><span class="tv num">${s.total ? (s.total / 1000).toFixed(1) + "K" : ""}</span><div class="stack" style="height:${Math.max((s.total / mx) * 100, s.total ? 3 : 0)}%"><span style="flex:${Math.max(s.fx, 0)};background:var(--fixed)"></span><span style="flex:${Math.max(s.vr, 0)};background:var(--var)"></span></div><small>${mShort(x)}</small></button>`)}</div></div>`;
}

// donut slice / legend / category row → that month's transactions of the category
on("click", "cat-go", (el) => {
  S.fCat = el.getAttribute("data-cat") || "all";
  S.fPerson = "all";
  S.tab = "tx";
  history.replaceState(null, "", "#/tx");
  rerender();
  window.scrollTo({ top: 0 });
});

on("click", "month", (el) => {
  S.month = el.dataset.m!;
  S.monthTouched = true;
  rerender();
});

on("click", "analyze", async () => {
  if (S.anBusy || !canWrite()) return;
  const m = S.month;
  if (!txOf(ctx(), m).length) return;
  S.anBusy = true;
  rerender();
  try {
    const r = await fn.analyze(m, monthSummaryText(ctx(), m));
    S.analyses[m] = { month: m, data: r.analysis.data, created_at: r.analysis.at };
  } catch (e: any) {
    flash(e?.message || "הניתוח לא הצליח. כדאי לנסות שוב.", "err");
  } finally {
    S.anBusy = false;
    rerender();
  }
});
