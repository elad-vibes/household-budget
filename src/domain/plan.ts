// Phase 2 domain logic (pure, unit-tested): budgets, upcoming bills and annual
// expenses, savings goals, fixed-expense suggestions, personal price history.
import { addM, norm } from "../lib/format.ts";
import { fixedMatch, isExcl, savedTx, type Ctx } from "./calc.ts";
import type { Fixed } from "./types.ts";

export interface Budget { household_id?: string; category: string; amount: number }
export interface Annual { id: string; name: string; amount: number; due_month: number; due_day: number; category: string; person_id: string | null; remind_days: number; note: string }
export interface Goal { id: string; name: string; target: number; target_date: string | null; archived: boolean }
export interface Deposit { id: string; goal_id: string; amount: number; date: string; note: string }
export interface ReceiptItem { name: string; norm_name: string; qty: number; unit_price: number | null; total: number | null; store: string; date: string }

// ------------------------------------------------------------------ budgets
export type BudgetLevel = "ok" | "warn" | "over";
export interface BudgetRow { category: string; amount: number; spent: number; pct: number; level: BudgetLevel }

/** Same thresholds as the database trigger: 80% = warn, 100% = over. */
export function budgetRows(ctx: Ctx, budgets: Budget[], month: string): BudgetRow[] {
  const tx = savedTx(ctx).filter((t) => t.month === month && !isExcl(t));
  return budgets.map((b) => {
    const spent = tx.filter((t) => t.category === b.category).reduce((a, t) => a + t.amount, 0);
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    return { category: b.category, amount: b.amount, spent, pct, level: (pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok") as BudgetLevel };
  }).sort((a, b) => b.pct - a.pct);
}

// ------------------------------------------------------- upcoming payments
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);

export function nextAnnualDue(a: Pick<Annual, "due_month" | "due_day">, today: Date): Date {
  const t = startOfDay(today);
  let y = t.getFullYear();
  let d = new Date(y, a.due_month - 1, Math.min(a.due_day, lastDay(y, a.due_month - 1)));
  if (d < t) {
    y++;
    d = new Date(y, a.due_month - 1, Math.min(a.due_day, lastDay(y, a.due_month - 1)));
  }
  return d;
}

export function nextFixedDue(f: Pick<Fixed, "due_day">, today: Date): Date | null {
  if (!f.due_day) return null;
  const t = startOfDay(today);
  let d = new Date(t.getFullYear(), t.getMonth(), Math.min(f.due_day, lastDay(t.getFullYear(), t.getMonth())));
  if (d < t) d = new Date(t.getFullYear(), t.getMonth() + 1, Math.min(f.due_day, lastDay(t.getFullYear(), t.getMonth() + 1)));
  return d;
}

export interface Upcoming { kind: "fixed" | "annual"; id: string; name: string; amount: number; date: Date; days: number }

/** Fixed monthly bills in the next `billDays` days + annual expenses inside their reminder window. */
export function upcoming(fixed: Fixed[], annual: Annual[], today: Date, billDays = 7): Upcoming[] {
  const out: Upcoming[] = [];
  for (const f of fixed) {
    if ((f.cycle || 1) !== 1) continue;
    const d = nextFixedDue(f, today);
    if (d && daysBetween(today, d) <= billDays) out.push({ kind: "fixed", id: f.id, name: f.name, amount: f.amount, date: d, days: daysBetween(today, d) });
  }
  for (const a of annual) {
    const d = nextAnnualDue(a, today);
    const days = daysBetween(today, d);
    if (days <= Math.max(a.remind_days, 0)) out.push({ kind: "annual", id: a.id, name: a.name, amount: a.amount, date: d, days });
  }
  return out.sort((x, y) => x.days - y.days);
}

/** Annual expenses in calendar order starting from today. */
export function annualCalendar(annual: Annual[], today: Date) {
  return annual.map((a) => ({ ...a, next: nextAnnualDue(a, today), days: daysBetween(today, nextAnnualDue(a, today)) }))
    .sort((a, b) => a.days - b.days);
}

// ---------------------------------------------------------------- goals
export function goalProgress(g: Goal, deposits: Deposit[], today: Date) {
  const saved = deposits.filter((d) => d.goal_id === g.id).reduce((a, d) => a + d.amount, 0);
  const remaining = Math.max(0, g.target - saved);
  const pct = Math.min(100, (saved / g.target) * 100);
  let monthsLeft: number | null = null, perMonth: number | null = null;
  if (g.target_date) {
    const end = new Date(g.target_date + "T00:00:00");
    monthsLeft = Math.max(1, (end.getFullYear() - today.getFullYear()) * 12 + (end.getMonth() - today.getMonth()));
    perMonth = remaining > 0 ? Math.ceil(remaining / monthsLeft) : 0;
  }
  return { saved, remaining, pct, monthsLeft, perMonth, done: saved >= g.target };
}

// ------------------------------------------------- fixed-expense suggestions
export interface Suggestion { key: string; merchant: string; amount: number; category: string; months: number }

const merchantKey = (m: string) => norm(m.replace(/\d{3,}/g, "")).slice(0, 24);

/**
 * "New 89 ₪ charge every month — add to fixed?" A merchant that appears once a
 * month in at least 2 of the last 3 months (including this or last month), with
 * amounts within 10% of each other, not marked fixed and not matched by an
 * existing fixed expense.
 */
export function suggestFixed(ctx: Ctx, month: string, dismissed: Set<string>): Suggestion[] {
  const months = [month, addM(month, -1), addM(month, -2)];
  const byKey = new Map<string, { m: string; merchant: string; amount: number; category: string }[]>();
  for (const t of savedTx(ctx)) {
    if (!months.includes(t.month) || isExcl(t) || t.is_fixed || t.amount <= 0 || fixedMatch(ctx, t)) continue;
    const k = merchantKey(t.merchant);
    if (!k) continue;
    const list = byKey.get(k) ?? [];
    list.push({ m: t.month, merchant: t.merchant, amount: t.amount, category: t.category });
    byKey.set(k, list);
  }
  const out: Suggestion[] = [];
  for (const [k, list] of byKey) {
    const perMonth = new Map<string, number>();
    for (const x of list) perMonth.set(x.m, (perMonth.get(x.m) ?? 0) + 1);
    if (perMonth.size < 2 || [...perMonth.values()].some((n) => n > 1)) continue;   // once a month
    if (!perMonth.has(months[0]) && !perMonth.has(months[1])) continue;             // still active
    const amounts = list.map((x) => x.amount).sort((a, b) => a - b);
    const med = amounts[Math.floor(amounts.length / 2)];
    if (amounts.some((a) => Math.abs(a - med) > med * 0.1)) continue;
    const key = "fixed:" + k;
    if (dismissed.has(key)) continue;
    const latest = list.sort((a, b) => b.m.localeCompare(a.m))[0];
    out.push({ key, merchant: latest.merchant, amount: latest.amount, category: latest.category, months: perMonth.size });
  }
  return out.sort((a, b) => b.amount - a.amount).slice(0, 5);
}

/** A keyword for the new fixed expense: the merchant's first meaningful word(s). */
export function keywordFor(merchant: string): string {
  const words = merchant.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w));
  return (words.slice(0, 2).join(" ") || merchant).slice(0, 40);
}

// ------------------------------------------------------------ price history
export interface PriceGroup { name: string; key: string; entries: { store: string; date: string; price: number }[]; cheapest: { store: string; price: number; date: string } }

export const itemKey = (s: string) => String(s || "").toLowerCase().replace(/["'׳״.,()*/\\-]/g, " ").replace(/\s+/g, " ").trim();

export function priceHistory(items: ReceiptItem[], query = ""): PriceGroup[] {
  const q = itemKey(query);
  const groups = new Map<string, PriceGroup>();
  for (const it of items) {
    const price = it.unit_price ?? (it.total !== null && it.qty ? it.total / it.qty : null);
    if (price === null || !(price > 0)) continue;
    const key = it.norm_name || itemKey(it.name);
    if (q && !key.includes(q)) continue;
    const g = groups.get(key) ?? { name: it.name, key, entries: [], cheapest: { store: it.store, price, date: it.date } };
    g.entries.push({ store: it.store, date: it.date, price: Math.round(price * 100) / 100 });
    if (price < g.cheapest.price) g.cheapest = { store: it.store, price, date: it.date };
    groups.set(key, g);
  }
  for (const g of groups.values()) g.entries.sort((a, b) => b.date.localeCompare(a.date));
  return [...groups.values()].sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}

/** For a shopping-list item: our cheapest recorded price, if we have one. */
export function cheapestFor(items: ReceiptItem[], shoppingName: string): { store: string; price: number } | null {
  const k = itemKey(shoppingName);
  if (k.length < 2) return null;
  const hits = priceHistory(items).filter((g) => g.key.includes(k) || k.includes(g.key));
  if (!hits.length) return null;
  const best = hits.map((g) => g.cheapest).sort((a, b) => a.price - b.price)[0];
  return { store: best.store, price: Math.round(best.price * 100) / 100 };
}
