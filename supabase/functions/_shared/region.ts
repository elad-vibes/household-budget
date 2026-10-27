// Household region (0016, DECISIONS #42): one setting per household that picks the defaults that used to be
// Israeli-only — base currency, time zone, number format, bank and payment-method lists, categories rules,
// price comparison. Shared by the app and the Edge Functions. "IL" is what every household had before 0016,
// so every default below for IL is exactly the old behavior.

export type Region = "IL" | "TH";

export interface RegionInfo {
  code: Region;
  /** shown in the settings picker */
  label: string;
  /** the household's base currency: transactions.amount is always in it */
  currency: "ILS" | "THB";
  symbol: string;
  /** "Israel" / "Thailand" as the AI prompts say it */
  place: string;
  tz: string;
  /** BCP 47 locale for numbers and dates (the UI stays Hebrew / RTL) */
  locale: string;
  /** the shopping-list price comparison (SuperMCP) only covers Israeli chains */
  priceCompare: boolean;
  /** a "small purchase" for the tips and the AI summary, in the base currency (60 ₪ ≈ 600 ฿) */
  smallPurchase: number;
  /** rough ₪→local factor for the fixed amount thresholds of the rule-based tips (1 ₪ ≈ 11 ฿; 10 keeps them round) */
  thresholdScale: number;
  /** default for the weekly summary day (0 = Sunday); the person can change it in the notification settings */
  weeklyDay: number;
  /** fallback text encodings for CSV files that are not UTF-8, in order */
  csvEncodings: string[];
}

export const REGIONS: Record<Region, RegionInfo> = {
  IL: { code: "IL", label: "ישראל · שקל ₪", currency: "ILS", symbol: "₪", place: "ישראל", tz: "Asia/Jerusalem", locale: "he-IL", priceCompare: true, smallPurchase: 60, thresholdScale: 1, weeklyDay: 0, csvEncodings: ["windows-1255"] },
  TH: { code: "TH", label: "תאילנד · באט ฿", currency: "THB", symbol: "฿", place: "תאילנד", tz: "Asia/Bangkok", locale: "he-IL", priceCompare: false, smallPurchase: 600, thresholdScale: 10, weeklyDay: 1, csvEncodings: ["windows-874", "windows-1255"] },
};

export const REGION_CODES = Object.keys(REGIONS) as Region[];
export const isRegion = (x: unknown): x is Region => typeof x === "string" && Object.prototype.hasOwnProperty.call(REGIONS, x);
/** Anything unknown (a column missing on an old row, a typo) is Israel — the pre-0016 behavior. */
export const regionOf = (x: unknown): RegionInfo => REGIONS[isRegion(x) ? x : "IL"];
