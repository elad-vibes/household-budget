// The budget month (feature 3): a household can start its month on day 1–28 (e.g. the
// 10th, salary day). ONE rule, mirrored in SQL by public.budget_month() (0013):
//
//   start day 1                       → the stored `month` (exactly the old behavior)
//   stored month ≠ the date's month   → the stored `month` (a card installment or a row the
//                                        statement moved — the statement decided its month)
//   otherwise                         → day ≥ start ? that month : the month before
//
// A budget month is named after the month it STARTS in: start 10 → "אוקטובר" = 10.10–9.11.
// Nothing is stored: changing the start day re-buckets every row at once (DECISIONS #37).
import { addM, today as todayStr } from "../lib/format.ts";

export interface Dated { date: string; month: string }

const clampStart = (s: number | null | undefined) => (Number.isInteger(s) && (s as number) >= 1 && (s as number) <= 28 ? (s as number) : 1);

export function budgetMonth(t: Dated, start?: number | null): string {
  const st = clampStart(start);
  if (st === 1 || t.date.slice(0, 7) !== t.month) return t.month;
  return Number(t.date.slice(8, 10)) >= st ? t.month : addM(t.month, -1);
}

/** The budget month that contains a calendar day ("YYYY-MM-DD"). */
export const budgetMonthOfDay = (day: string, start?: number | null) => budgetMonth({ date: day, month: day.slice(0, 7) }, start);

/** The budget month we are in today (device time). */
export const currentBudgetMonth = (start?: number | null, now = new Date()) => budgetMonthOfDay(todayStr(now), start);

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (m: string) => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();

/** First and last calendar day of a budget month ("YYYY-MM-DD", inclusive). */
export function budgetRange(m: string, start?: number | null): { from: string; to: string } {
  const st = clampStart(start);
  if (st === 1) return { from: `${m}-01`, to: `${m}-${pad(lastDay(m))}` };
  const next = addM(m, 1);
  return { from: `${m}-${pad(st)}`, to: `${next}-${pad(st - 1)}` };
}

/** "10.10–9.11" — shown under the month name when the month doesn't start on the 1st. */
export function rangeLabel(m: string, start?: number | null): string {
  const { from, to } = budgetRange(m, start);
  const dm = (d: string) => `${+d.slice(8, 10)}.${+d.slice(5, 7)}`;
  return `${dm(from)}–${dm(to)}`;
}

/** Days left in the budget month, counting today; 0 when `day` is outside it. */
export function daysLeft(m: string, start: number | null | undefined, day: string): number {
  const { from, to } = budgetRange(m, start);
  if (day < from || day > to) return 0;
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((ms(to) - ms(day)) / 86_400_000) + 1;
}
