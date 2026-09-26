// Phase 2 domain logic with synthetic data.
import { describe, expect, it } from "vitest";
import {
  annualCalendar, budgetRows, cheapestFor, goalProgress, keywordFor, nextAnnualDue, nextFixedDue, priceHistory, suggestFixed, upcoming,
  type Annual, type ReceiptItem,
} from "../../src/domain/plan.ts";
import type { Ctx } from "../../src/domain/calc.ts";
import type { Fixed, Tx } from "../../src/domain/types.ts";

let n = 0;
const tx = (month: string, merchant: string, amount: number, category = "תקשורת ומנויים", over: Partial<Tx> = {}): Tx => ({
  id: `t${++n}`, household_id: "h", date: `${month}-07`, month, merchant, amount, category, is_fixed: false, note: "",
  person_id: null, source: "import", source_title: "", status: "saved", ...over,
});
const fixed = (over: Partial<Fixed> = {}): Fixed => ({ id: "f1", household_id: "h", name: "ביטוח", amount: 89, keyword: "הראל", category: "ביטוחים", person_id: null, cycle: 1, due_day: 10, note: "", ...over });

describe("budgets", () => {
  it("80% warns, 100% is over, excluded categories and receipts under review don't count", () => {
    const ctx: Ctx = { people: [], fixed: [], tx: [
      tx("2026-09", "מסעדה", 400, "אוכל בחוץ ומשלוחים"), tx("2026-09", "וולט", 450, "אוכל בחוץ ומשלוחים"),
      tx("2026-09", "שופרסל", 900, "סופר ומכולת"), tx("2026-09", "קבלה", 500, "סופר ומכולת", { status: "review" }),
      tx("2026-08", "מסעדה", 999, "אוכל בחוץ ומשלוחים"),
    ] };
    const rows = budgetRows(ctx, [{ category: "אוכל בחוץ ומשלוחים", amount: 800 }, { category: "סופר ומכולת", amount: 1000 }, { category: "ביגוד והנעלה", amount: 300 }], "2026-09");
    expect(rows.map((r) => [r.category, r.level])).toEqual([["אוכל בחוץ ומשלוחים", "over"], ["סופר ומכולת", "warn"], ["ביגוד והנעלה", "ok"]]);
    expect(rows[1].spent).toBe(900);
  });
});

describe("upcoming payments and the annual calendar", () => {
  const today = new Date(2026, 8, 26); // 26 Sep 2026
  const annual: Annual[] = [
    { id: "a1", name: "ביטוח רכב", amount: 2400, due_month: 10, due_day: 5, category: "ביטוחים", person_id: null, remind_days: 14, note: "" },
    { id: "a2", name: "מנוי שנתי", amount: 300, due_month: 3, due_day: 31, category: "תקשורת ומנויים", person_id: null, remind_days: 14, note: "" },
    { id: "a3", name: "חוג", amount: 1200, due_month: 9, due_day: 1, category: "חינוך וחוגים", person_id: null, remind_days: 30, note: "" },
  ];
  it("next due dates roll over the year and clip to the month length", () => {
    expect(nextAnnualDue(annual[0], today).toDateString()).toBe(new Date(2026, 9, 5).toDateString());
    expect(nextAnnualDue(annual[2], today).toDateString()).toBe(new Date(2027, 8, 1).toDateString());
    expect(nextAnnualDue({ due_month: 2, due_day: 31 }, today).getDate()).toBe(28);
    expect(nextFixedDue({ due_day: 31 }, new Date(2026, 10, 15))!.getDate()).toBe(30);
    expect(nextFixedDue({ due_day: 10 }, today)!.toDateString()).toBe(new Date(2026, 9, 10).toDateString());
  });
  it("upcoming = bills within a week + annual inside the reminder window", () => {
    const u = upcoming([fixed({ due_day: 1 }), fixed({ id: "f2", due_day: 20 }), fixed({ id: "f3", due_day: 2, cycle: 12 })], annual, today);
    expect(u.map((x) => [x.kind, x.id, x.days])).toEqual([["fixed", "f1", 5], ["annual", "a1", 9]]);
    expect(annualCalendar(annual, today).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("savings goals", () => {
  it("progress and how much to put aside each month", () => {
    const g = { id: "g", name: "חופשה", target: 6000, target_date: "2027-03-01", archived: false };
    const p = goalProgress(g, [{ id: "d1", goal_id: "g", amount: 1500, date: "2026-09-01", note: "" }, { id: "d2", goal_id: "x", amount: 99, date: "2026-09-01", note: "" }], new Date(2026, 8, 26));
    expect(p).toMatchObject({ saved: 1500, remaining: 4500, pct: 25, monthsLeft: 6, perMonth: 750, done: false });
  });
});

describe("fixed-expense suggestions", () => {
  const base = (): Ctx => ({ people: [], fixed: [fixed({ keyword: "הראל" })], tx: [
    tx("2026-07", "חדר כושר אנרג'י", 189), tx("2026-08", "חדר כושר אנרג'י", 189), tx("2026-09", "חדר כושר אנרג'י", 189),
    tx("2026-08", "GYM 123456 PAY", 89), tx("2026-09", "GYM 998877 PAY", 89),
    tx("2026-08", "הראל ביטוח", 89), tx("2026-09", "הראל ביטוח", 89),             // already a fixed expense
    tx("2026-08", "שופרסל", 300, "סופר ומכולת"), tx("2026-09", "שופרסל", 540, "סופר ומכולת"), // amounts vary too much
    tx("2026-09", "וולט", 60, "אוכל בחוץ ומשלוחים"), tx("2026-09", "וולט", 70, "אוכל בחוץ ומשלוחים"), tx("2026-08", "וולט", 65, "אוכל בחוץ ומשלוחים"), // several a month
    tx("2026-06", "עמותה", 50), tx("2026-07", "עמותה", 50),                          // stopped
  ] });
  it("finds monthly repeating charges and ignores the rest", () => {
    const s = suggestFixed(base(), "2026-09", new Set());
    expect(s.map((x) => [x.merchant, x.amount, x.months])).toEqual([["חדר כושר אנרג'י", 189, 3], ["GYM 998877 PAY", 89, 2]]);
  });
  it("dismissed suggestions stay dismissed", () => {
    const first = suggestFixed(base(), "2026-09", new Set());
    expect(suggestFixed(base(), "2026-09", new Set([first[0].key])).map((x) => x.amount)).toEqual([89]);
  });
  it("keyword for the new fixed expense", () => {
    expect(keywordFor("GYM 998877 PAY")).toBe("GYM PAY");
    expect(keywordFor("חדר כושר אנרג'י")).toBe("חדר כושר");
  });
});

describe("personal price history", () => {
  const items: ReceiptItem[] = [
    { name: "חלב 3% 1 ליטר", norm_name: "חלב 3% 1 ליטר", qty: 2, unit_price: 6.9, total: 13.8, store: "סופר א", date: "2026-09-01" },
    { name: "חלב 3% 1 ליטר", norm_name: "חלב 3% 1 ליטר", qty: 1, unit_price: 6.2, total: 6.2, store: "סופר ב", date: "2026-09-10" },
    { name: "לחם אחיד", norm_name: "לחם אחיד", qty: 1, unit_price: null, total: 7.5, store: "מכולת", date: "2026-09-12" },
    { name: "בננה", norm_name: "בננה", qty: 1, unit_price: null, total: null, store: "שוק", date: "2026-09-12" },
  ];
  it("groups by product and finds where it was cheapest for us", () => {
    const h = priceHistory(items);
    expect(h[0]).toMatchObject({ key: "חלב 3% 1 ליטר", cheapest: { store: "סופר ב", price: 6.2 } });
    expect(h.map((g) => g.key)).toEqual(["חלב 3% 1 ליטר", "לחם אחיד"]); // items without a price are skipped
    expect(priceHistory(items, "לחם").map((g) => g.key)).toEqual(["לחם אחיד"]);
  });
  it("shopping-list hint", () => {
    expect(cheapestFor(items, "חלב")).toEqual({ store: "סופר ב", price: 6.2 });
    expect(cheapestFor(items, "גבינה")).toBeNull();
  });
});
