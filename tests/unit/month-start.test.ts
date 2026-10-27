// Feature 3: budget month start (1–28), "כמה נשאר להיום", yearly report.
import { describe, expect, it } from "vitest";
import { sumM, txOf, type Ctx } from "../../src/domain/calc.ts";
import { budgetMonth, budgetMonthOfDay, budgetRange, currentBudgetMonth, daysLeft, rangeLabel } from "../../src/domain/month.ts";
import { allowance, budgetRows, yearReport } from "../../src/domain/plan.ts";
import type { Tx } from "../../src/domain/types.ts";

let n = 0;
const tx = (date: string, amount: number, category = "סופר ומכולת", over: Partial<Tx> = {}): Tx => ({
  id: `t${++n}`, household_id: "h", date, month: date.slice(0, 7), merchant: "מכולת", amount, category,
  is_fixed: false, note: "", person_id: null, source: "manual", source_title: "", status: "saved", ...over,
});

describe("budgetMonth", () => {
  it("start 1 (default, or anything invalid) = the stored month", () => {
    for (const s of [undefined, null, 1, 0, 29, 3.5]) expect(budgetMonth({ date: "2026-10-09", month: "2026-10" }, s)).toBe("2026-10");
  });

  it("start 10: the 9th belongs to the month before, the 10th starts the month", () => {
    expect(budgetMonth({ date: "2026-10-09", month: "2026-10" }, 10)).toBe("2026-09");
    expect(budgetMonth({ date: "2026-10-10", month: "2026-10" }, 10)).toBe("2026-10");
    expect(budgetMonth({ date: "2026-01-05", month: "2026-01" }, 10)).toBe("2025-12");
  });

  it("a row whose stored month differs from its date (installment / statement month) keeps the stored month", () => {
    expect(budgetMonth({ date: "2026-08-03", month: "2026-10" }, 10)).toBe("2026-10");
  });

  it("start 28 and February", () => {
    expect(budgetMonthOfDay("2026-02-27", 28)).toBe("2026-01");
    expect(budgetMonthOfDay("2026-02-28", 28)).toBe("2026-02");
    expect(budgetMonthOfDay("2026-03-01", 28)).toBe("2026-02");
    expect(budgetMonthOfDay("2028-02-29", 28)).toBe("2028-02");
    expect(budgetMonthOfDay("2028-02-29", 1)).toBe("2028-02");
  });

  it("ranges, labels and days left", () => {
    expect(budgetRange("2026-10", 10)).toEqual({ from: "2026-10-10", to: "2026-11-09" });
    expect(budgetRange("2026-12", 10)).toEqual({ from: "2026-12-10", to: "2027-01-09" });
    expect(budgetRange("2026-01", 28)).toEqual({ from: "2026-01-28", to: "2026-02-27" });
    expect(budgetRange("2028-02", 1)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(rangeLabel("2026-10", 10)).toBe("10.10–9.11");
    expect(daysLeft("2026-10", 1, "2026-10-31")).toBe(1);
    expect(daysLeft("2026-10", 10, "2026-11-09")).toBe(1);
    expect(daysLeft("2026-10", 10, "2026-10-10")).toBe(31);
    expect(daysLeft("2026-10", 10, "2026-11-10")).toBe(0);
    expect(currentBudgetMonth(10, new Date(2026, 9, 9, 23, 0))).toBe("2026-09");
    expect(currentBudgetMonth(10, new Date(2026, 9, 10, 0, 1))).toBe("2026-10");
  });
});

describe("routing every monthly number through the budget month", () => {
  const rows = [tx("2026-10-09", 100), tx("2026-10-10", 200), tx("2026-11-09", 300), tx("2026-11-10", 400),
    tx("2026-08-03", 50, "ביגוד והנעלה", { month: "2026-10", note: "תשלום 2 מתוך 3" })];

  it("changing the start day mid-month re-buckets rows but never loses or doubles a shekel", () => {
    const by1: Ctx = { people: [], fixed: [], tx: rows };
    const by10: Ctx = { ...by1, startDay: 10 };
    expect(txOf(by1, "2026-10").map((t) => t.amount).sort((a, b) => a - b)).toEqual([50, 100, 200]);
    expect(txOf(by10, "2026-10").map((t) => t.amount).sort((a, b) => a - b)).toEqual([50, 200, 300]);
    expect(txOf(by10, "2026-09").map((t) => t.amount)).toEqual([100]);
    const total = (c: Ctx) => ["2026-09", "2026-10", "2026-11"].reduce((a, m) => a + sumM(c, m).total, 0);
    expect(total(by10)).toBe(total(by1));
  });

  it("budgets fill by budget month", () => {
    const [r] = budgetRows({ people: [], fixed: [], tx: rows, startDay: 10 }, [{ category: "סופר ומכולת", amount: 600 }], "2026-10");
    expect([r.spent, r.level]).toEqual([500, "warn"]);
  });
});

describe("כמה נשאר להיום", () => {
  const ctx: Ctx = { people: [], fixed: [], startDay: 10, tx: [tx("2026-10-12", 700), tx("2026-10-20", 450, "אוכל בחוץ ומשלוחים")] };
  const budgets = [{ category: "סופר ומכולת", amount: 1500 }, { category: "אוכל בחוץ ומשלוחים", amount: 500 }, { category: "ביגוד והנעלה", amount: 0 }];

  it("remaining per category and per day until the end of the budget month (today included)", () => {
    const a = allowance(ctx, budgets, "2026-11-01")!;
    expect([a.month, a.to, a.days]).toEqual(["2026-10", "2026-11-09", 9]);
    const groc = a.rows.find((r) => r.category === "סופר ומכולת")!;
    expect([groc.remaining, groc.perDay]).toEqual([800, 88]);   // floor(800 / 9)
    const food = a.rows.find((r) => r.category === "אוכל בחוץ ומשלוחים")!;
    expect([food.remaining, food.perDay, food.level]).toEqual([50, 5, "warn"]);
    expect(a.rows.some((r) => r.category === "ביגוד והנעלה")).toBe(false);   // a 0 budget is no budget
    expect(a.perDay).toBe(93);
  });

  it("over budget → 0 left, never negative; no budgets → nothing to show", () => {
    const over = allowance({ ...ctx, tx: [...ctx.tx, tx("2026-10-25", 200, "אוכל בחוץ ומשלוחים")] }, budgets, "2026-11-01")!;
    expect(over.rows.find((r) => r.category === "אוכל בחוץ ומשלוחים")).toMatchObject({ remaining: 0, perDay: 0, level: "over" });
    expect(allowance(ctx, [], "2026-11-01")).toBeNull();
  });
});

describe("yearly report", () => {
  it("12 budget months ending at the chosen one, by category, income and excluded rows left out", () => {
    const ctx: Ctx = { people: [], fixed: [], startDay: 10, tx: [
      tx("2026-10-09", 100), tx("2026-10-10", 200), tx("2025-11-10", 30, "ביגוד והנעלה"), tx("2025-11-09", 999),
      tx("2026-10-15", 9000, "הכנסה"),
    ] };
    const y = yearReport(ctx, "2026-10");
    expect(y.months[0]).toBe("2025-11");
    expect(y.months[11]).toBe("2026-10");
    expect(y.rows.map((r) => [r.category, r.total])).toEqual([["סופר ומכולת", 300], ["ביגוד והנעלה", 30]]);
    expect(y.rows[0].byMonth[10]).toBe(100);   // 9.10 belongs to the September budget month
    expect(y.rows[0].byMonth[11]).toBe(200);
    expect(y.total).toBe(330);   // 9.11.2025 is in the October 2025 budget month → outside the 12
  });
});
