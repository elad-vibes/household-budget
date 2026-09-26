// Statement ↔ receipt matcher (payment-methods.md) with synthetic data.
import { describe, expect, it } from "vitest";
import {
  detectMethod, eligible, findStatementRow, initialStatus, matchStatement, merchantSimilarity, resolveMatches,
  type PaymentMethod, type SRow, type Waiting,
} from "../../src/domain/match.ts";

const pm = (id: string, type: PaymentMethod["type"], issuer = "", last4: string | null = null): PaymentMethod =>
  ({ id, type, label: id, issuer, last4, person_id: null, active: true, sort: 0 });
const MAX = pm("max", "credit_card", "מקס", "1111");
const ISRA = pm("isra", "credit_card", "ישראכרט", "2222");
const CASH = pm("cash", "cash");
const BIT = pm("bit", "bit_paybox");
const BANK = pm("bank", "bank_transfer", "בנק דמו");
const METHODS = [MAX, ISRA, CASH, BIT, BANK];

const w = (id: string, date: string, amount: number, merchant: string, methodId = "max"): Waiting => ({ id, date, amount, merchant, methodId });
const r = (key: string, date: string, amount: number, merchant: string, note = ""): SRow => ({ key, date, amount, merchant, note });
// a statement always runs past the items (so they are "covered")
const tail = r("tail", "2026-08-31", 12, "חניון העירייה");

describe("statuses and eligibility", () => {
  it("cash and 'other' never wait for a statement; cards, bit and transfers do", () => {
    expect(initialStatus(CASH)).toBe("none");
    expect(initialStatus(pm("o", "other"))).toBe("none");
    expect(initialStatus(MAX)).toBe("awaiting_statement");
    expect(initialStatus(BIT)).toBe("awaiting_statement");
    expect(initialStatus(null)).toBe("none");
  });

  it("same method, or bit rows on any statement; never another card", () => {
    expect(eligible(MAX, MAX, "x")).toBe(true);
    expect(eligible(ISRA, MAX, "x")).toBe(false);
    expect(eligible(CASH, MAX, "x")).toBe(false);
    expect(eligible(BIT, BANK, "העברה ב-BIT")).toBe(true);
    expect(eligible(BIT, BANK, "סופר השכונה")).toBe(false);
    // same issuer, card number unknown on one side
    expect(eligible(pm("max2", "credit_card", "מקס"), MAX, "x")).toBe(true);
    expect(eligible(pm("max3", "credit_card", "מקס", "3333"), MAX, "x")).toBe(false);
  });

  it("merchant similarity survives branch names, final letters and punctuation", () => {
    expect(merchantSimilarity("סופר השכונה", "סופר השכונה בע\"מ")).toBeGreaterThanOrEqual(0.8);
    expect(merchantSimilarity("קפה גן", "קפה-גן סניף 3")).toBeGreaterThanOrEqual(0.5);
    expect(merchantSimilarity("חנות הספרים", "תחנת דלק")).toBeLessThan(0.5);
  });
});

describe("matchStatement", () => {
  it("exact amount + close date + similar merchant → automatic merge", () => {
    const res = matchStatement([w("a", "2026-08-10", 120.5, "סופר השכונה")], [r("1", "2026-08-11", 120.5, "סופר השכונה בעמ"), tail], MAX, METHODS);
    expect(res.merges).toEqual([{ rowKey: "1", itemId: "a" }]);
    expect(res.ambiguous).toEqual([]);
    expect(resolveMatches(res, {}).leftovers).toEqual([]);
  });

  it("±1₪ and the −2…+5 day window", () => {
    const items = [w("a", "2026-08-10", 99.4, "מאפיית הכיכר"), w("b", "2026-08-10", 50, "מאפיית הכיכר")];
    const res = matchStatement(items, [r("1", "2026-08-15", 100, "מאפיית הכיכר"), r("2", "2026-08-07", 50, "מאפיית הכיכר"), tail], MAX, METHODS);
    expect(res.merges).toEqual([{ rowKey: "1", itemId: "a" }]); // +5 days, 0.6₪ off: ok; −3 days: out
    expect(resolveMatches(res, {}).leftovers).toEqual(["b"]);
    const late = matchStatement([w("a", "2026-08-10", 100, "מאפיית הכיכר")], [r("1", "2026-08-16", 100, "מאפיית הכיכר"), tail], MAX, METHODS);
    expect(late.merges).toEqual([]);
  });

  it("installments: the receipt shows the full amount, the statement the first payment", () => {
    const res = matchStatement([w("a", "2026-08-05", 1200, "חשמל ועוד")], [r("1", "2026-08-05", 400, "חשמל ועוד", "תשלום 1 מתוך 3"), tail], MAX, METHODS);
    expect(res.merges).toEqual([{ rowKey: "1", itemId: "a" }]);
    const second = matchStatement([w("a", "2026-08-05", 1200, "חשמל ועוד")], [r("1", "2026-08-05", 400, "חשמל ועוד", "תשלום 2 מתוך 3"), tail], MAX, METHODS);
    expect(second.merges).toEqual([]);
  });

  it("two candidates for one row → ambiguous, the user decides; one item merges once", () => {
    const items = [w("a", "2026-08-10", 60, "קפה גן"), w("b", "2026-08-11", 60, "קפה גן")];
    const res = matchStatement(items, [r("1", "2026-08-11", 60, "קפה גן"), tail], MAX, METHODS);
    expect(res.merges).toEqual([]);
    expect(res.ambiguous[0].rowKey).toBe("1");
    expect(res.ambiguous[0].candidates.map((c) => c.itemId).sort()).toEqual(["a", "b"]);
    const done = resolveMatches(res, { "1": "b" });
    expect(done.merges).toEqual([{ rowKey: "1", itemId: "b" }]);
    expect(done.leftovers).toEqual(["a"]);
  });

  it("an unsure single candidate (different merchant, amount only within 1₪) waits for the user", () => {
    const res = matchStatement([w("a", "2026-08-10", 80, "חנות הספרים")], [r("0", "2026-08-01", 5, "דמי כרטיס"), r("1", "2026-08-13", 80.6, "PAYPAL *XYZ"), tail], MAX, METHODS);
    expect(res.merges).toEqual([]);
    expect(res.ambiguous).toHaveLength(1);
    expect(resolveMatches(res, { "1": "" }).leftovers).toEqual(["a"]);
  });

  it("no candidate: other card, cash, too far away — nothing merges, rows are imported as usual", () => {
    const items = [w("a", "2026-08-10", 45, "פיצה", "isra"), w("c", "2026-08-10", 45, "פיצה", "cash")];
    const res = matchStatement(items, [r("1", "2026-08-10", 45, "פיצה"), tail], MAX, METHODS);
    expect(res).toEqual({ merges: [], ambiguous: [], covered: [] });
  });

  it("refunds only match refunds", () => {
    const res = matchStatement([w("a", "2026-08-10", -30, "חנות צעצועים"), w("b", "2026-08-09", 30, "חנות צעצועים")],
      [r("1", "2026-08-12", -30, "חנות צעצועים"), tail], MAX, METHODS);
    expect(res.merges).toEqual([{ rowKey: "1", itemId: "a" }]);
  });

  it("items near the end of the statement are not 'covered' yet (their row may be next month)", () => {
    const res = matchStatement([w("a", "2026-08-29", 70, "מכולת")], [r("1", "2026-08-01", 5, "x"), tail], MAX, METHODS);
    expect(res.covered).toEqual([]);
  });

  it("bank statement: bit transfers match waiting bit items", () => {
    const res = matchStatement([w("a", "2026-08-10", 150, "החזר לשכנה", "bit")], [r("1", "2026-08-10", 150, "העברה ב-BIT"), tail], BANK, METHODS);
    expect(res.merges).toEqual([{ rowKey: "1", itemId: "a" }]);
  });
});

describe("statement first, receipt later", () => {
  it("finds the one saved statement row", () => {
    const rows = [{ ...r("t1", "2026-08-11", 88, "סופר השכונה"), methodId: "max" }, { ...r("t2", "2026-08-11", 88, "סופר השכונה"), methodId: "isra" }];
    expect(findStatementRow(w("a", "2026-08-10", 88, "סופר השכונה"), rows, METHODS)?.key).toBe("t1");
    expect(findStatementRow(w("a", "2026-08-10", 88, "סופר השכונה", "cash"), rows, METHODS)).toBeNull();
    expect(findStatementRow(w("a", "2026-08-10", 88, "סופר השכונה"), [...rows, { ...rows[0], key: "t3" }], METHODS)).toBeNull(); // two → unsure
  });
});

describe("detectMethod", () => {
  it("last 4 digits, cash, issuer name, bit", () => {
    expect(detectMethod("כרטיס 1111 פירוט חיובים", METHODS)?.id).toBe("max");
    expect(detectMethod("אשראי ****2222", METHODS)?.id).toBe("isra");
    expect(detectMethod("שולם במזומן", METHODS)?.id).toBe("cash");
    expect(detectMethod("פירוט ישראכרט ספטמבר", METHODS)?.id).toBe("isra");
    expect(detectMethod("paybox", METHODS)?.id).toBe("bit");
    expect(detectMethod("ויזה", METHODS)).toBeNull();
  });
});
