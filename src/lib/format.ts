// Formatting helpers ported from the prototype.
import { baseSymbol, region } from "./region.ts";

export const HEB_M = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
export const HEB_D = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** An amount in the household's BASE currency (₪ for an Israeli household, ฿ for a Thai one — 0016). */
export const ils = (n: number, d = 0) =>
  (n < 0 ? "-" : "") + baseSymbol() + Math.abs(n).toLocaleString(region().locale, { minimumFractionDigits: d, maximumFractionDigits: d });
export const ils2 = (n: number) => ils(n, n % 1 ? 2 : 0);

export const mLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return HEB_M[+mm - 1] + " " + y;
};
export const mShort = (m: string) => HEB_M[+m.split("-")[1] - 1].slice(0, 3) + "׳";
export const monthName = (m: string) => HEB_M[+m.split("-")[1] - 1];

export const addM = (m: string, k: number) => {
  let [y, mm] = m.split("-").map(Number);
  mm += k;
  while (mm < 1) { mm += 12; y--; }
  while (mm > 12) { mm -= 12; y++; }
  return y + "-" + String(mm).padStart(2, "0");
};

export const ddmm = (d: string) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) : "");

export const uid = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
};

/** Normalizes merchant names for matching (prototype's norm). */
export const norm = (s: string) => String(s || "").toLowerCase().replace(/[\s"'׳״\-–.]/g, "");

export const curMonth = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
export const today = (d = new Date()) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });
}
