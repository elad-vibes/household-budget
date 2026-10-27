// Month boundaries — the behavior BEFORE "budget month start" (feature 3). These pin
// what every monthly number does today; with the default start day (1) they must stay
// green after the change, so the new month logic can't silently move a shekel.
import { describe, expect, it } from "vitest";
import { fixedStatus, monthsWithData, sumM, txOf, type Ctx } from "../../src/domain/calc.ts";
import { budgetRows, suggestFixed } from "../../src/domain/plan.ts";
import { addM, curMonth } from "../../src/lib/format.ts";
import type { Fixed, Tx } from "../../src/domain/types.ts";

let n = 0;
const tx = (date: string, amount: number, category = "סופר ומכולת", over: Partial<Tx> = {}): Tx => ({
  id: `t${++n}`, household_id: "h", date, month: date.slice(0, 7), merchant: "מכולת השכונה", amount, category,
  is_fixed: false, note: "", person_id: null, source: "manual", source_title: "", status: "saved", ...over,
});
const bill = (over: Partial<Fixed> = {}): Fixed => ({ id: "f1", household_id: "h", name: "ארנונה", amount: 600, keyword: "עירייה", category: "חשבונות בית", person_id: null, cycle: 1, due_day: 1, note: "", ...over });

describe("month math", () => {
  it("addM crosses years in both directions; curMonth is the calendar month of the device", () => {
    expect(addM("2026-12", 1)).toBe("2027-01");
    expect(addM("2026-01", -1)).toBe("2025-12");
    expect(addM("2026-03", -14)).toBe("2025-01");
    expect(curMonth(new Date(2026, 9, 31, 23, 59))).toBe("2026-10");
    expect(curMonth(new Date(2026, 10, 1, 0, 0))).toBe("2026-11");
  });
});

describe("which month a transaction counts in (today: the stored `month`, not the date)", () => {
  const ctx: Ctx = { people: [], fixed: [], tx: [
    tx("2026-10-31", 100), tx("2026-11-01", 200),
    tx("2028-02-29", 50), tx("2028-03-01", 70),
    // a card installment: bought in August, moved by the statement parser to the statement's month
    tx("2026-08-14", 300, "ביגוד והנעלה", { month: "2026-10", note: "תשלום 3 מתוך 6" }),
    tx("2026-10-15", 9000, "הכנסה"),
    tx("2026-10-20", 1500, "חיוב אשראי מרוכז"),
    tx("2026-10-10", 999, "סופר ומכולת", { status: "review" }),
  ] };

  it("last day vs first day of the month split", () => {
    expect(txOf(ctx, "2026-10").map((t) => t.amount).sort((a, b) => a - b)).toEqual([100, 300, 1500, 9000]);
    expect(txOf(ctx, "2026-11").map((t) => t.amount)).toEqual([200]);
    expect(txOf(ctx, "2026-08")).toEqual([]);   // the installment is NOT in its purchase month
  });

  it("February in a leap year", () => {
    expect(sumM(ctx, "2028-02").total).toBe(50);
    expect(sumM(ctx, "2028-03").total).toBe(70);
  });

  it("totals exclude income and card-settlement rows; income is reported separately; review rows never count", () => {
    expect(sumM(ctx, "2026-10")).toEqual({ fx: 0, vr: 400, total: 400, inc: 9000, count: 2 });
  });

  it("months with data come from the stored month", () => {
    expect(monthsWithData(ctx)).toEqual(["2026-10", "2026-11", "2028-02", "2028-03"]);
  });
});

describe("budgets and fixed expenses at the boundary", () => {
  it("a budget fills only from its own month's rows", () => {
    const ctx: Ctx = { people: [], fixed: [], tx: [tx("2026-10-31", 800), tx("2026-11-01", 900)] };
    const [oct] = budgetRows(ctx, [{ category: "סופר ומכולת", amount: 1000 }], "2026-10");
    const [nov] = budgetRows(ctx, [{ category: "סופר ומכולת", amount: 1000 }], "2026-11");
    expect([oct.spent, oct.level, nov.spent, nov.level]).toEqual([800, "warn", 900, "warn"]);
  });

  it("a bill charged on the 1st of the next month counts in that next month", () => {
    const ctx: Ctx = { people: [], fixed: [bill()], tx: [tx("2026-11-01", 600, "חשבונות בית", { merchant: "עירייה תל אביב" })] };
    expect(fixedStatus(ctx, bill(), "2026-10").kind).toBe("miss");
    expect(fixedStatus(ctx, bill(), "2026-11").kind).toBe("ok");
  });

  it("fixed-expense suggestions look at the stored months (this + 2 back)", () => {
    const m = (d: string) => tx(d, 89, "תקשורת ומנויים", { merchant: "סלקום טלוויזיה" });
    const ctx: Ctx = { people: [], fixed: [], tx: [m("2026-08-31"), m("2026-09-30"), m("2026-11-01")] };
    expect(suggestFixed(ctx, "2026-10", new Set()).map((s) => s.months)).toEqual([2]);
    expect(suggestFixed(ctx, "2026-11", new Set()).map((s) => s.months)).toEqual([2]);
  });
});
