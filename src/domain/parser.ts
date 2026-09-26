// Excel/CSV statement parser — a typed port of the prototype's localParse.
// Runs entirely on the device; files never leave the phone.
//   * Hebrew headers (תאריך עסקה / שם בית העסק / סכום חיוב / חובה / זכות …)
//   * CSV decoded as UTF-8, falling back to windows-1255 (Israeli bank exports)
//   * installments "תשלום X מתוך Y" moved into the statement's main month
//   * bank statements: debit/credit columns, credit → income
//   * card lump-sum debits on bank statements → "חיוב אשראי מרוכז" (excluded)
//   * loud column checks (columns.ts): missing columns or 0 rows → ImportError, never a silent empty import
import { addM } from "../lib/format.ts";
import { catOf } from "./categories.ts";
import { headerComplete, mapHeader, missingColumnsError, missingOf, noRowsError } from "./columns.ts";
export { ImportError } from "./columns.ts";

export interface ParsedRow { date: string; month: string; merchant: string; amount: number; category: string; fixed: boolean; note: string }
export interface ParseResult { docType: "bank" | "credit_card"; title: string; statementTotal: null; rows: ParsedRow[] }

type Cell = string | number | Date | boolean | null | undefined;
export type Sheet = Cell[][];

/** Excel serial day → date (the 1900 date system, with Excel's leap-year bug). */
function excelSerialToDate(v: number): string {
  const ms = Math.round((v - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

export function parseDate(v: Cell): string {
  if (v instanceof Date && !isNaN(+v)) {
    return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0");
  }
  if (typeof v === "number" && v > 20000 && v < 80000) return excelSerialToDate(v);
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = "20" + y;
    const mo = +m[2], d = +m[1];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return y + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  return "";
}

export function parseAmt(v: Cell): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[^\d.]/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : NaN;
}

/**
 * Core parser over already-read sheets (pure; unit-tested with synthetic files).
 * Throws ImportError (loud) when the columns are missing or no row could be read.
 */
export function parseSheets(sheets: Sheet[], title: string): ParseResult {
  const rows: ParsedRow[] = [];
  let bankMode = false, headerFound = false, skipped = 0;
  let found: string[] = [];
  let best = { score: -1, cells: [] as string[], missing: missingOf({ date: -1, merchant: -1, amount: -1, debit: -1, credit: -1, signed: -1, note: -1 }) };
  for (const data of sheets) {
    for (let i = 0; i < Math.min(data.length, 40); i++) {
      const raw = data[i] ?? [];
      const cells = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
      const m = mapHeader(raw);
      if (!headerComplete(m)) {
        const score = (m.date >= 0 ? 1 : 0) + (m.merchant >= 0 ? 1 : 0) + (m.amount >= 0 || m.debit >= 0 || m.signed >= 0 ? 1 : 0);
        if (cells.length >= 2 && score > best.score) best = { score, cells: cells.slice(0, 20), missing: missingOf(m) };
        continue;
      }
      headerFound = true;
      found = cells.slice(0, 20);
      bankMode = bankMode || m.debit >= 0 || m.signed >= 0;
      for (let k = i + 1; k < data.length; k++) {
        const row = data[k] ?? [];
        if (!row.some((c) => String(c ?? "").trim())) continue;
        const date = parseDate(row[m.date]);
        const merchant = String(row[m.merchant] ?? "").trim();
        if (!date || !merchant) { skipped++; continue; }
        let amount: number, forceInc = false;
        if (m.debit >= 0) {
          const d = parseAmt(row[m.debit]), c = m.credit >= 0 ? parseAmt(row[m.credit]) : NaN;
          if (isFinite(d) && d !== 0) amount = Math.abs(d);
          else if (isFinite(c) && c !== 0) { amount = Math.abs(c); forceInc = true; }
          else { skipped++; continue; }
        } else if (m.signed >= 0) {
          const v = parseAmt(row[m.signed]);
          if (!isFinite(v) || v === 0) { skipped++; continue; }
          amount = Math.abs(v);
          forceInc = v > 0;
        } else {
          amount = parseAmt(row[m.amount]);
          if (!isFinite(amount) || amount === 0) { skipped++; continue; }
        }
        const note = m.note >= 0 ? String(row[m.note] ?? "").trim() : "";
        let { category, fixed } = catOf(merchant + " " + note);
        if (forceInc && category !== "חיוב אשראי מרוכז") category = "הכנסה";
        if (!forceInc && category === "הכנסה") category = "שונות";
        const inst = note.match(/תשלום\s*(\d+)\s*מתוך\s*(\d+)/);
        rows.push({
          date, month: date.slice(0, 7), merchant: merchant.slice(0, 80),
          amount: Math.round(amount * 100) / 100, category, fixed,
          note: inst ? `תשלום ${inst[1]} מתוך ${inst[2]}` : note.slice(0, 40),
        });
      }
      break;
    }
  }
  if (!headerFound) throw missingColumnsError(title, best.cells, best.missing);
  if (!rows.length) throw noRowsError(title, found, skipped);
  // Card statements: installments and old standing orders belong to the statement's main month.
  if (!bankMode) {
    const cnt: Record<string, number> = {};
    rows.forEach((r) => (cnt[r.month] = (cnt[r.month] || 0) + 1));
    const main = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    rows.forEach((r) => {
      if (r.month !== main && (/תשלום/.test(r.note) || r.month < addM(main, -1))) r.month = main;
    });
  }
  return { docType: bankMode ? "bank" : "credit_card", title, statementTotal: null, rows };
}

export function fileKind(f: { name: string; type: string }): "xlsx" | "csv" | "pdf" | "img" | "other" {
  const n = f.name.toLowerCase();
  if (/\.(xlsx|xls)$/.test(n)) return "xlsx";
  if (/\.csv$/.test(n) || f.type === "text/csv") return "csv";
  if (/\.pdf$/.test(n) || f.type === "application/pdf") return "pdf";
  if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif)$/.test(n)) return "img";
  return "other";
}

/** CSV bytes → text: strict UTF-8 first, then windows-1255. */
export function decodeCsv(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1255").decode(buf);
  }
}

/** Reads an Excel/CSV file with SheetJS (loaded on demand) and parses it. */
export async function localParse(file: File): Promise<ParseResult> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = fileKind(file) === "csv"
    ? XLSX.read(decodeCsv(buf), { type: "string", raw: true })
    : XLSX.read(buf, { type: "array", cellDates: true });
  const sheets = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
  return parseSheets(sheets, file.name);
}
