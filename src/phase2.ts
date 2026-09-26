// Phase 2 wiring: loads budgets / annual / goals / price history / push state
// and plugs cards into existing screens (overview, fixed, shopping, home).
import { attr, html, type SafeHtml } from "./lib/html.ts";
import { on } from "./lib/events.ts";
import { ils, ils2, HEB_D } from "./lib/format.ts";
import { dbMessage, invoke, sb } from "./lib/supa.ts";
import { canWrite, ctx, flash, rerender, S } from "./state.ts";
import { saveFixed } from "./data.ts";
import {
  budgetRows, cheapestFor, keywordFor, priceHistory, suggestFixed, upcoming,
  type Annual, type Budget, type Deposit, type Goal, type ReceiptItem,
} from "./domain/plan.ts";
import { currentSubscription, disablePush, enablePush, isIOS, standalone } from "./lib/push.ts";
import { overviewCards } from "./ui/overview.ts";
import { fixedTop } from "./ui/fixed.ts";
import { shopExtras } from "./ui/shop.ts";
import { homeCards } from "./ui/home.ts";

export interface Prefs { weekly_summary: boolean; bills: boolean; receipts: boolean; budget: boolean; weekly_day: number; quiet_start: number; quiet_end: number }
export interface P2State {
  budgets: Budget[]; annual: Annual[]; goals: Goal[]; deposits: Deposit[]; items: ReceiptItem[];
  dismissed: Set<string>; prefs: Prefs | null; pushOn: boolean; priceQuery: string;
}
const DEFAULT_PREFS: Prefs = { weekly_summary: true, bills: true, receipts: true, budget: true, weekly_day: 0, quiet_start: 22, quiet_end: 7 };
export const P2 = (): P2State =>
  (S.extra.p2 ??= { budgets: [], annual: [], goals: [], deposits: [], items: [], dismissed: new Set(), prefs: null, pushOn: false, priceQuery: "" });

const num = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadPhase2() {
  if (!S.hh) return;
  const hh = S.hh;
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const [b, a, g, d, it, ds, pr] = await Promise.all([
    sb.from("budgets").select("category, amount").eq("household_id", hh),
    sb.from("annual_expenses").select("*").eq("household_id", hh),
    sb.from("savings_goals").select("*").eq("household_id", hh).order("created_at"),
    sb.from("goal_deposits").select("id, goal_id, amount, date, note").eq("household_id", hh).order("date", { ascending: false }),
    sb.from("receipt_items").select("name, norm_name, qty, unit_price, total, store, date").eq("household_id", hh).gte("date", since).limit(3000),
    sb.from("suggestion_dismissals").select("key").eq("household_id", hh),
    sb.from("notification_prefs").select("*").eq("user_id", S.user!.id).maybeSingle(),
  ]);
  if (S.hh !== hh) return;
  const p = P2();
  p.budgets = (b.data ?? []).map((x: any) => ({ category: x.category, amount: num(x.amount) }));
  p.annual = (a.data ?? []).map((x: any) => ({ ...x, amount: num(x.amount) }));
  p.goals = (g.data ?? []).map((x: any) => ({ ...x, target: num(x.target) }));
  p.deposits = (d.data ?? []).map((x: any) => ({ ...x, amount: num(x.amount) }));
  p.items = (it.data ?? []).map((x: any) => ({ ...x, qty: num(x.qty) || 1, unit_price: nn(x.unit_price), total: nn(x.total) }));
  p.dismissed = new Set((ds.data ?? []).map((x: any) => x.key));
  p.prefs = pr.data ? (pr.data as Prefs) : null;
  p.pushOn = !!(await currentSubscription().catch(() => null));
}

// ------------------------------------------------------------ overview cards
overviewCards.push((m) => {
  const rows = budgetRows(ctx(), P2().budgets, m);
  if (!rows.length) return html``;
  return html`<div class="card"><div class="card-h"><h2>תקציבים החודש</h2><button class="ghost" data-click="go" data-to="plan">עריכה</button></div>
    ${rows.slice(0, 6).map((r) => html`<div><div class="row between small"><b>${r.category}</b><span class="num">${ils(r.spent)} / ${ils(r.amount)}${r.level !== "ok" ? html` <span class="chip ${r.level === "over" ? "miss" : "warn"}">${Math.round(r.pct)}%</span>` : ""}</span></div>
      <div class="bar ${r.level === "over" ? "over" : r.level === "warn" ? "warn" : ""}"><span style="width:${Math.min(100, r.pct)}%"></span></div></div>`)}</div>`;
});

overviewCards.push(() => {
  const list = upcoming(S.fixed, P2().annual, new Date());
  if (!list.length) return html``;
  return html`<div class="card"><div class="card-h"><h2>חיובים קרובים</h2><span class="muted small">קבועות בשבוע הקרוב ושנתיות</span></div>
    ${list.slice(0, 6).map((u) => html`<div class="fxrow"><div class="n">${u.name}<small>${u.kind === "annual" ? "שנתי" : "חודשי"} · ${u.date.getDate()}/${u.date.getMonth() + 1}</small></div>
      <div class="a num">${ils2(u.amount)}</div><span class="chip ${u.days <= 2 ? "warn" : "grey"}">${u.days === 0 ? "היום" : u.days === 1 ? "מחר" : `בעוד ${u.days} ימים`}</span></div>`)}</div>`;
});

function suggestionsCard(limit: number): SafeHtml {
  if (!canWrite()) return html``;
  const list = suggestFixed(ctx(), S.month, P2().dismissed).slice(0, limit);
  if (!list.length) return html``;
  return html`<div class="card"><h2>נראה כמו הוצאה קבועה</h2>
    ${list.map((s) => html`<div class="fxrow"><div class="n">${s.merchant}<small>חיוב של ${ils2(s.amount)} ב-${s.months} החודשים האחרונים</small></div><span></span>
      <div class="row" style="gap:4px"><button class="primary" data-click="sug-add" data-key="${s.key}">להוסיף לקבועות</button><button class="ghost" data-click="sug-no" data-key="${s.key}">לא</button></div></div>`)}</div>`;
}
overviewCards.push(() => suggestionsCard(3));
fixedTop.push(() => suggestionsCard(5));

on("click", "sug-add", async (el) => {
  const s = suggestFixed(ctx(), S.month, P2().dismissed).find((x) => x.key === el.dataset.key);
  if (!s) return;
  try {
    await saveFixed({ name: s.merchant.slice(0, 60), amount: s.amount, keyword: keywordFor(s.merchant), category: s.category, person_id: null, cycle: 1, due_day: null, note: "" });
    flash(`✓ ${s.merchant} נוסף להוצאות הקבועות`, "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "sug-no", async (el) => {
  const key = el.dataset.key!;
  P2().dismissed.add(key);
  rerender();
  await sb.from("suggestion_dismissals").insert({ household_id: S.hh, key });
});

// ------------------------------------------------------------- shopping
shopExtras.hint = (name: string) => {
  const c = cheapestFor(P2().items, name);
  return c ? html`<small>הכי זול אצלנו: ${ils2(c.price)}${c.store ? ` · ${c.store}` : ""}</small>` : "";
};
shopExtras.cards.push(() => {
  const p = P2();
  if (!p.items.length) return html`<div class="card"><h2>המחירים שלנו</h2><p class="muted small">כשקבלות נקראות, המחיר של כל מוצר נשמר כאן. ככה רואים איפה חלב (או כל דבר אחר) היה הכי זול לכם.</p></div>`;
  const groups = priceHistory(p.items, p.priceQuery).slice(0, 12);
  return html`<div class="card"><h2>המחירים שלנו</h2>
    <input type="search" id="priceQ" data-change="price-q" placeholder="חיפוש מוצר (למשל: חלב)" value="${p.priceQuery}" aria-label="חיפוש מוצר">
    ${groups.length ? groups.map((g) => html`<div class="fxrow"><div class="n">${g.name}<small>${g.entries.slice(0, 3).map((e) => `${ils2(e.price)} ${e.store} (${e.date.slice(8, 10)}/${e.date.slice(5, 7)})`).join(" · ")}</small></div><span></span>
      <span class="chip save">הכי זול: ${ils2(g.cheapest.price)}${g.cheapest.store ? ` · ${g.cheapest.store}` : ""}</span></div>`) : html`<p class="muted small">לא נמצא.</p>`}
  </div>`;
});
on("change", "price-q", (el) => { P2().priceQuery = (el as HTMLInputElement).value.trim(); rerender(); });

// ------------------------------------------------------------ notifications
homeCards.push(() => {
  const p = P2();
  const pr = p.prefs ?? DEFAULT_PREFS;
  const iosNeedsInstall = isIOS() && !standalone();
  const toggle = (k: keyof Prefs, label: string) => html`<label class="chk"><input type="checkbox" data-change="pref" data-k="${k}" ${attr(pr[k], "checked")}> ${label}</label>`;
  const hours = (k: "quiet_start" | "quiet_end") => html`<select data-change="pref" data-k="${k}">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${attr(pr[k] === h, "selected")}>${String(h).padStart(2, "0")}:00</option>`)}</select>`;
  return html`<div class="card"><h2>התראות</h2>
    ${iosNeedsInstall ? html`<p class="small">באייפון, התראות עובדות רק כשהאפליקציה מותקנת במסך הבית (iOS 16.4 ומעלה). <a href="#/install">איך מתקינים?</a></p>` : ""}
    ${p.pushOn
      ? html`<p>✓ ההתראות פעילות במכשיר הזה.</p><div class="row"><button data-click="push-test">התראת בדיקה</button><button class="ghost" data-click="push-off">כיבוי במכשיר הזה</button></div>`
      : html`<div><button class="primary" data-click="push-on" ${attr(iosNeedsInstall, "disabled")}>הפעלת התראות במכשיר הזה</button></div>`}
    <div class="grid2">${toggle("weekly_summary", "סיכום שבועי")}${toggle("bills", "חיובים קרובים ושנתיות")}${toggle("receipts", "קבלות מוכנות לאישור")}${toggle("budget", "התראות תקציב (80% / 100%)")}</div>
    <label class="f">יום הסיכום השבועי<select data-change="pref" data-k="weekly_day">${HEB_D.map((d, i) => html`<option value="${i}" ${attr(pr.weekly_day === i, "selected")}>יום ${d}</option>`)}</select></label>
    <div class="grid2"><label class="f">שעות שקטות מ-${hours("quiet_start")}</label><label class="f">עד ${hours("quiet_end")}</label></div>
    <p class="muted small">בשעות השקטות לא נשלחות התראות; הן מחכות לבוקר.</p>
  </div>`;
});

on("click", "push-on", async () => {
  const r = await enablePush();
  const msg: Record<string, string> = {
    ok: "✓ ההתראות הופעלו", denied: "ההרשאה להתראות נחסמה. אפשר לאפשר אותה בהגדרות הדפדפן/הטלפון.",
    unsupported: "הדפדפן הזה לא תומך בהתראות.", "install-first": "באייפון צריך קודם להתקין את האפליקציה במסך הבית.",
    noconfig: "ההתראות עוד לא הוגדרו בשרת.", error: "ההפעלה לא הצליחה. כדאי לנסות שוב.",
  };
  flash(msg[r], r === "ok" ? "ok" : "err");
  P2().pushOn = r === "ok" || P2().pushOn;
  rerender();
});
on("click", "push-off", async () => { await disablePush(); P2().pushOn = false; rerender(); });
on("click", "push-test", async () => {
  try {
    const r = await invoke<{ sent: number }>("notify", { action: "test" });
    flash(r.sent ? "נשלחה התראת בדיקה" : "לא נמצא מכשיר רשום. אפשר להפעיל שוב.", r.sent ? "ok" : "warn");
  } catch (e: any) { flash(e.message, "err"); }
});
on("change", "pref", async (el) => {
  const p = P2();
  const k = el.dataset.k as keyof Prefs;
  const v = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : Number((el as HTMLSelectElement).value);
  p.prefs = { ...(p.prefs ?? DEFAULT_PREFS), [k]: v } as Prefs;
  const { error } = await sb.from("notification_prefs").upsert({ user_id: S.user!.id, ...p.prefs });
  if (error) flash(dbMessage(error), "err");
  rerender();
});

