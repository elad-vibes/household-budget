// "מצב טיול" (next-features.md §5): the app side of foreign currency. Conversion and parsing
// are shared with the Edge Functions (one rounding rule everywhere); rates come from fx-rates.
export { CURRENCIES, crossRate, parseForeign, toIls } from "../../supabase/functions/_shared/fx.ts";
import { CURRENCIES } from "../../supabase/functions/_shared/fx.ts";
import { baseCode, baseSymbol, region } from "../lib/region.ts";

export interface FxRates {
  fetched: "cached" | "fetched" | "partial" | "down";
  stale: boolean;
  lastSuccess: string | null;
  official: Record<string, { rate: number; date: string; source: "boi" | "ecb" | "cross" }>;
  /** 0016: the base currency the rates are quoted in ("ILS" for every household before) */
  base?: string;
  manual: Record<string, { rate: number; date: string }>;
}

export interface Rate { rate: number; date: string; source: "boi" | "ecb" | "cross" | "manual" }

/** The rate the household converts with: its manual rate, else the official one. null = none yet. */
export function rateOf(r: FxRates | null | undefined, code: string): Rate | null {
  if (!r) return null;
  const m = r.manual[code];
  if (m) return { rate: Number(m.rate), date: m.date, source: "manual" };
  const o = r.official[code];
  return o ? { rate: Number(o.rate), date: o.date, source: o.source } : null;
}

export const SOURCE_LABEL: Record<Rate["source"], string> = {
  boi: "שער יציג, בנק ישראל",
  ecb: "שער הבנק המרכזי האירופי",
  cross: "שער צולב: בנק ישראל והבנק המרכזי האירופי",   // 0016: the base is not the shekel, so the rate goes through it
  manual: "שער ידני",
};

export const symbolOf = (code: string) => CURRENCIES.find((c) => c.code === code)?.symbol ?? code;
/** The currencies a household can travel with: everything but its own base currency. */
export const travelCurrencies = () => CURRENCIES.filter((c) => c.code !== baseCode());
export const nameOf = (code: string) => CURRENCIES.find((c) => c.code === code)?.name ?? code;

/** "฿350" / "350 CHF" — the original amount as people read it. */
export function fmtForeign(amount: number, code: string): string {
  const sym = symbolOf(code);
  const n = Math.abs(amount).toLocaleString(region().locale, { maximumFractionDigits: 2 });
  const s = sym.length === 1 || sym.endsWith("$") || sym === "E£" ? `${sym}${n}` : `${n} ${sym}`;
  return amount < 0 ? "-" + s : s;
}

/** "1 ฿ = ₪0.0911" (or "1 ₪ = ฿10.97") with as many digits as a small rate needs. */
export function fmtRate(rate: number, code: string): string {
  const digits = rate < 0.1 ? 4 : rate < 1 ? 3 : 2;
  return `1 ${symbolOf(code)} = ${baseSymbol()}${rate.toFixed(digits)}`;
}
