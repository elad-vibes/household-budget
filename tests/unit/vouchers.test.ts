// Feature 4: voucher wallet helpers (the balance itself is tested in tests/rls/vouchers.test.ts).
import { describe, expect, it } from "vitest";
import { daysToExpiry, expiringSoon, last4, reminderWindow, walletOrder, type Voucher } from "../../src/domain/vouchers.ts";

const v = (over: Partial<Voucher>): Voucher => ({ id: Math.random().toString(36), name: "שובר", issuer: "", initial_amount: 100, balance: 100,
  currency: "ILS", expires_on: null, note: "", code_last4: null, payment_method_id: null, archived: false, ...over });

describe("vouchers", () => {
  it("days to expiry and the reminder windows match the database rule (30 / 7 / 1)", () => {
    expect(daysToExpiry(v({ expires_on: "2026-11-01" }), "2026-10-31")).toBe(1);
    expect(daysToExpiry(v({}), "2026-10-31")).toBeNull();
    const w = (exp: string, over: Partial<Voucher> = {}) => reminderWindow(v({ expires_on: exp, ...over }), "2026-10-20");
    expect([w("2026-11-25"), w("2026-11-19"), w("2026-10-28"), w("2026-10-27"), w("2026-10-21"), w("2026-10-20"), w("2026-10-19")])
      .toEqual([null, 30, 30, 7, 1, 1, null]);
    expect(w("2026-10-21", { balance: 0 })).toBeNull();
    expect(w("2026-10-21", { archived: true })).toBeNull();
  });

  it("expiring soon: money left, within 30 days, soonest first; the wallet shows usable ones first", () => {
    const list = [v({ name: "ב", expires_on: "2026-11-15" }), v({ name: "א", expires_on: "2026-10-25" }), v({ name: "ריק", expires_on: "2026-10-22", balance: 0 }),
      v({ name: "פג", expires_on: "2026-10-01" }), v({ name: "בלי תוקף" }), v({ name: "ארכיון", expires_on: "2026-10-23", archived: true })];
    expect(expiringSoon(list, "2026-10-20").map((x) => [x.name, x.days])).toEqual([["א", 5], ["ב", 26]]);
    expect(walletOrder(list, "2026-10-20").map((x) => x.name)).toEqual(["א", "ב", "בלי תוקף", "פג", "ריק", "ארכיון"]);
  });

  it("only the last 4 characters of a code are kept", () => {
    expect(last4("ABCD-1234-5678-9XYZ")).toBe("9XYZ");
    expect(last4(" 12 ")).toBeNull();
  });
});
