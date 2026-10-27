// Foreign currency (next-features.md §5): official daily rates, conversion and parsing.
// Shared by the fx-rates / capture / poll-batches functions and the app (src/domain/fx.ts).
// Sources (free, official, no key, nothing about the household is sent — plain GETs):
//   1. Bank of Israel representative rates (שער יציג) — 14 currencies, published ~13:30 Israel.
//   2. ECB euro reference rates, crossed through EUR→ILS — for the currencies the Bank of
//      Israel doesn't publish (THB, TRY, PLN, …). Cached in fx_rates (0015), fetched once a day.
import type { Deps } from "./deps.ts";

export const BOI_URL = "https://boi.org.il/PublicApi/GetExchangeRates?asJson=true";
export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
/** What the Bank of Israel publishes — the ECB cross rate is used only for the others. */
export const BOI_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "DKK", "NOK", "SEK", "ZAR", "JOD", "LBP", "EGP"];
const TIMEOUT_MS = 10_000;

export interface FxRow { currency: string; date: string; rate: number; source: "boi" | "ecb" }

/** Currencies the app offers, with the symbol people see on receipts. */
export const CURRENCIES: { code: string; name: string; symbol: string }[] = [
  { code: "THB", name: "באט תאילנדי", symbol: "฿" },
  { code: "USD", name: "דולר אמריקאי", symbol: "$" },
  { code: "EUR", name: "אירו", symbol: "€" },
  { code: "GBP", name: "לירה שטרלינג", symbol: "£" },
  { code: "JPY", name: "ין יפני", symbol: "¥" },
  { code: "CHF", name: "פרנק שווייצרי", symbol: "CHF" },
  { code: "TRY", name: "לירה טורקית", symbol: "₺" },
  { code: "PLN", name: "זלוטי פולני", symbol: "zł" },
  { code: "CZK", name: "קורונה צ׳כית", symbol: "Kč" },
  { code: "HUF", name: "פורינט הונגרי", symbol: "Ft" },
  { code: "RON", name: "לאו רומני", symbol: "lei" },
  { code: "AUD", name: "דולר אוסטרלי", symbol: "A$" },
  { code: "CAD", name: "דולר קנדי", symbol: "C$" },
  { code: "INR", name: "רופי הודי", symbol: "₹" },
  { code: "SGD", name: "דולר סינגפורי", symbol: "S$" },
  { code: "JOD", name: "דינר ירדני", symbol: "JD" },
  { code: "EGP", name: "לירה מצרית", symbol: "E£" },
];
export const CURRENCY = /^[A-Z]{3}$/;

/** ₪ amount of a foreign amount — rounded to agorot like Postgres numeric round(x, 2) (half away from zero). */
export function toIls(original: number, rate: number): number {
  const v = Number((Math.abs(original) * rate).toFixed(8));   // kill float noise before rounding (350 × 0.0905)
  return Math.sign(original) * Math.round(v * 100) / 100;
}

const israelDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

/** Bank of Israel JSON → rows (₪ per 1 unit; JPY is quoted per 100). */
export function parseBoi(raw: any): FxRow[] {
  const out: FxRow[] = [];
  for (const r of Array.isArray(raw?.exchangeRates) ? raw.exchangeRates : []) {
    const code = String(r?.key ?? "").toUpperCase();
    const rate = Number(r?.currentExchangeRate), unit = Number(r?.unit) || 1;
    const when = new Date(String(r?.lastUpdate ?? ""));
    if (!CURRENCY.test(code) || code === "ILS" || !(rate > 0) || isNaN(when.getTime())) continue;
    out.push({ currency: code, date: israelDate(when), rate: Math.round((rate / unit) * 1e6) / 1e6, source: "boi" });
  }
  return out;
}

/** ECB daily XML → cross rates through the euro: ₪ per 1 X = (₪ per €) / (X per €). */
export function parseEcb(xml: string): FxRow[] {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const per: Record<string, number> = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) per[m[1]] = Number(m[2]);
  const ils = per.ILS;
  if (!date || !(ils > 0)) return [];
  const out: FxRow[] = [{ currency: "EUR", date, rate: ils, source: "ecb" }];
  for (const [code, r] of Object.entries(per)) {
    if (code !== "ILS" && r > 0) out.push({ currency: code, date, rate: Math.round((ils / r) * 1e6) / 1e6, source: "ecb" });
  }
  return out;
}

/** "฿350", "THB 1,250.00", "€12,50", "350" → { amount, currency } (currency "" = not stated). */
export function parseForeign(text: unknown): { amount: number; currency: string } | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  let currency = "";
  const code = /\b([A-Za-z]{3})\b/.exec(s)?.[1]?.toUpperCase();
  if (code && (code === "ILS" || code === "NIS" || CURRENCIES.some((c) => c.code === code))) currency = code === "NIS" ? "ILS" : code;
  else if (/₪|ש["״']?ח/.test(s)) currency = "ILS";
  else {
    const sym = [...CURRENCIES].sort((a, b) => b.symbol.length - a.symbol.length).find((c) => s.includes(c.symbol));
    if (sym) currency = sym.code;
  }
  let n = s.replace(/[^\d.,]/g, "");
  if (n.includes(",") && n.includes(".")) n = n.lastIndexOf(",") > n.lastIndexOf(".") ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
  else if (n.includes(",")) n = /,\d{1,2}$/.test(n) ? n.replace(",", ".") : n.replace(/,/g, "");
  const amount = parseFloat(n);
  if (!isFinite(amount) || amount <= 0) return null;
  return { amount: Math.round((/^-|−/.test(s) ? -amount : amount) * 100) / 100, currency };
}

async function get(deps: Deps, url: string, as: "json" | "text") {
  const f = deps.fetch ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, { signal: ctl.signal, headers: { Accept: as === "json" ? "application/json" : "application/xml" } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return as === "json" ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetches today's rates into the cache when due (svc_fx_claim decides — at most once a day plus
 * once after the 13:30 publication; a failure waits 30 minutes). Never throws: on an outage the
 * cache keeps serving the last rates (callers show their date).
 * "cached" = not due · "fetched" = both sources · "partial" = one source · "down" = neither.
 */
export async function refreshRates(deps: Deps): Promise<"cached" | "fetched" | "partial" | "down"> {
  try {
    if (!(await deps.rpc<boolean>("svc_fx_claim", { p_now: deps.now().toISOString() }))) return "cached";
  } catch {
    return "down";
  }
  const [boi, ecb] = await Promise.allSettled([get(deps, BOI_URL, "json"), get(deps, ECB_URL, "text")]);
  const boiRows = boi.status === "fulfilled" ? parseBoi(boi.value) : [];
  const ecbRows = (ecb.status === "fulfilled" ? parseEcb(String(ecb.value)) : [])
    .filter((r) => !BOI_CURRENCIES.includes(r.currency) || !boiRows.length);   // BoI down → ECB covers everything
  const rows = [...boiRows, ...ecbRows];
  deps.log("fx_fetch", { boi: boiRows.length, ecb: ecbRows.length });
  if (!rows.length) return "down";
  try {
    await deps.rpc("svc_fx_put", { p_rows: rows, p_now: deps.now().toISOString() });
  } catch {
    return "down";
  }
  return boiRows.length && ecbRows.length ? "fetched" : "partial";
}
