// מצב טיול (feature 5), app side: which rate wins, how originals are shown, and the matcher's
// wider tolerance for a purchase abroad (the card charges its own rate + fees).
import { describe, expect, it } from "vitest";
import { fmtForeign, fmtRate, rateOf, symbolOf, toIls, type FxRates } from "../../src/domain/fx.ts";
import { pairInfo, type SRow, type Waiting } from "../../src/domain/match.ts";

const RATES: FxRates = {
  fetched: "cached", stale: false, lastSuccess: "2026-10-26T12:00:00Z",
  official: { THB: { rate: 0.0911, date: "2026-10-26", source: "ecb" }, USD: { rate: 3.078, date: "2026-10-26", source: "boi" } },
  manual: { USD: { rate: 3.2, date: "2026-10-27" } },
};

describe("rates", () => {
  it("a manual rate wins over the official one; unknown → null", () => {
    expect(rateOf(RATES, "THB")).toEqual({ rate: 0.0911, date: "2026-10-26", source: "ecb" });
    expect(rateOf(RATES, "USD")).toEqual({ rate: 3.2, date: "2026-10-27", source: "manual" });
    expect(rateOf(RATES, "EUR")).toBeNull();
    expect(rateOf(null, "THB")).toBeNull();
  });

  it("conversion is the same rounding as the database (agorot, half away from zero)", () => {
    expect(toIls(350, 0.0905)).toBe(31.68);
    expect(toIls(0.5, 0.01)).toBe(0.01);   // 0.005 → up
    expect(toIls(1234.56, 3.2)).toBe(3950.59);
  });

  it("shows the original the way people read it", () => {
    expect(fmtForeign(350, "THB")).toBe("฿350");
    expect(fmtForeign(1250.5, "USD")).toMatch(/^\$1,?250\.5$/);
    expect(fmtForeign(-20, "EUR")).toBe("-€20");
    expect(fmtForeign(40, "CHF")).toBe("40 CHF");
    expect(fmtRate(0.0911, "THB")).toBe("1 ฿ = ₪0.0911");
    expect(fmtRate(3.078, "USD")).toBe("1 $ = ₪3.08");
    expect(symbolOf("ILS")).toBe("₪");   // the manual form's "סכום (₪)" label (caught by E2E)
  });
});

describe("matcher: a purchase abroad", () => {
  const w = (amount: number, foreign: boolean): Waiting => ({ id: "w", date: "2026-10-24", amount, merchant: "מלון", methodId: "max", foreign });
  const r = (amount: number): SRow => ({ key: "r", date: "2026-10-26", amount, merchant: "HOTEL CHIANG MAI", note: "" });

  it("logged at the official rate, charged ~3% more by the card → still the same purchase", () => {
    expect(pairInfo(w(273.3, true), r(281.4))).not.toBeNull();     // +2.96%
    expect(pairInfo(w(273.3, true), r(290))).toBeNull();           // +6.1% — too far
  });

  it("a ₪ purchase keeps the ±1₪ rule", () => {
    expect(pairInfo(w(273.3, false), r(274.2))).not.toBeNull();
    expect(pairInfo(w(273.3, false), r(281.4))).toBeNull();
  });

  it("small foreign amounts never get less than ±1₪", () => {
    expect(pairInfo(w(9.11, true), r(10))).not.toBeNull();
  });
});
