// Loud column checks for Excel/CSV imports — ported from the hub's
// engine/tabular.py: "a silent zero is more dangerous than a crash".
// A file without a date / merchant / amount column FAILS with the list of
// columns that were found; a file whose columns are right but yields 0 rows
// fails too. Nothing is ever imported silently as "0 rows".
//
// Header aliases per issuer (as seen in their Excel/CSV exports). Higher score
// wins when several columns match. Matching ignores spaces, quotes and case.

export type ColKey = "date" | "merchant" | "amount" | "debit" | "credit" | "signed" | "note";

interface Alias { re: RegExp; score: number; source: string }

export const ALIASES: Record<ColKey, Alias[]> = {
  date: [
    { re: /^תאריךעסקה$|^תאריךהעסקה$/, score: 5, source: "מקס · כאל · לאומי קארד" },
    { re: /^תאריךרכישה$/, score: 5, source: "ישראכרט · אמריקן אקספרס" },
    { re: /^transactiondate$/i, score: 4, source: "English exports" },
    { re: /^תאריך$|^date$/i, score: 3, source: "בנקים (הפועלים, לאומי, מזרחי)" },
    { re: /^תאריךפעולה$|^תאריךהפעולה$/, score: 3, source: "בנקים" },
    { re: /^תאריךערך$|^יוםערך$/, score: 1, source: "בנקים (תאריך ערך)" },
    { re: /תאריך|date/i, score: 1, source: "כללי" },
  ],
  merchant: [
    { re: /^שםביתה?עסק$|^ביתה?עסק$/, score: 5, source: "מקס · ישראכרט · כאל" },
    { re: /^merchant(name)?$|^payee$/i, score: 4, source: "English exports" },
    { re: /^תיאורהפעולה$|^תיאור$|^תאור$|^הפעולה$|^description$/i, score: 4, source: "בנקים (תאור = כתיב נפוץ)" },
    { re: /^פרטים$|^details$|^פירוט$/i, score: 3, source: "בנקים" },
    { re: /ביתה?עסק|merchant/i, score: 2, source: "כללי" },
    { re: /תיאור|תאור|description/i, score: 1, source: "כללי" },
  ],
  amount: [
    { re: /^סכוםחיוב$|^סכוםלחיוב$|^סכוםהחיוב$/, score: 6, source: "מקס · ישראכרט · כאל (הסכום שחויב בפועל בשקלים)" },
    { re: /^סכוםחיובבש"?ח$|^חיובבש"?ח$|^סכוםבש"?ח$/, score: 6, source: "כאל · לאומי קארד" },
    { re: /^סכום$|^amount$/i, score: 3, source: "כללי" },
    { re: /^סכוםעסקה$|^סכוםהעסקה$/, score: 1, source: "סכום מקורי (רק אם אין עמודת חיוב)" },
    { re: /סכום|amount/i, score: 1, source: "כללי" },
  ],
  debit: [{ re: /^חובה$|^בחובה$|^debit$/i, score: 3, source: "הפועלים · לאומי · מזרחי" }],
  credit: [{ re: /^זכות$|^בזכות$|^credit$/i, score: 3, source: "הפועלים · לאומי · מזרחי" }],
  signed: [{ re: /^₪?זכות\/חובה₪?$|^₪?חובה\/זכות₪?$/, score: 3, source: "דיסקונט (עמודה אחת עם סימן)" }],
  note: [
    { re: /^הערות$|^פירוטנוסף$|^notes?$/i, score: 2, source: "מקס · ישראכרט" },
    { re: /^סוגעסקה$/, score: 1, source: "מקס" },
  ],
};

export const HEB_NAME: Record<ColKey, string> = {
  date: "תאריך", merchant: "בית עסק / תיאור", amount: "סכום", debit: "חובה", credit: "זכות", signed: "זכות/חובה", note: "הערות",
};

const normHeader = (s: unknown) => String(s ?? "").replace(/[\s"'׳״()\-_.:]/g, "").replace(/["]/g, "").toLowerCase();

/** Picks the best column for each key in a header row. -1 = not found. */
export function mapHeader(row: unknown[]): Record<ColKey, number> {
  const cells = row.map((c) => normHeader(c));
  const out = {} as Record<ColKey, number>;
  const used = new Set<number>();
  // amount-like keys after date/merchant so "סכום" isn't stolen by a looser rule
  for (const key of ["date", "merchant", "signed", "debit", "credit", "amount", "note"] as ColKey[]) {
    let best = -1, bs = 0;
    cells.forEach((c, i) => {
      if (!c || used.has(i)) return;
      for (const a of ALIASES[key]) if (a.re.test(c) && a.score > bs) { bs = a.score; best = i; }
    });
    out[key] = best;
    if (best >= 0) used.add(best);
  }
  return out;
}

export function headerComplete(m: Record<ColKey, number>): boolean {
  return m.date >= 0 && m.merchant >= 0 && (m.amount >= 0 || m.debit >= 0 || m.signed >= 0);
}

export function missingOf(m: Record<ColKey, number>): string[] {
  const miss: string[] = [];
  if (m.date < 0) miss.push(HEB_NAME.date);
  if (m.merchant < 0) miss.push(HEB_NAME.merchant);
  if (m.amount < 0 && m.debit < 0 && m.signed < 0) miss.push(HEB_NAME.amount);
  return miss;
}

export class ImportError extends Error {
  constructor(
    message: string,
    public kind: "missing_columns" | "no_rows",
    public found: string[],
    public missing: string[],
  ) {
    super(message);
  }
}

export function missingColumnsError(fileName: string, found: string[], missing: string[]): ImportError {
  const list = found.length ? found.join(", ") : "לא נמצאה שורת כותרות";
  return new ImportError(
    `${fileName}: חסרות עמודות נדרשות: ${missing.join(", ")}. העמודות שנמצאו בקובץ: ${list}. ` +
    "אפשר להוריד מחדש את קובץ היצוא המקורי מאתר הבנק או חברת האשראי (לא קובץ שנערך ידנית).",
    "missing_columns", found, missing);
}

export function noRowsError(fileName: string, found: string[], skipped: number): ImportError {
  return new ImportError(
    `${fileName}: העמודות זוהו (${found.join(", ")}), אבל אף שורה לא נקראה` +
    (skipped ? ` — ${skipped} שורות דולגו כי חסר בהן תאריך או סכום תקין` : "") +
    ". כלום לא נשמר. כדאי לבדוק שזה הקובץ הנכון.",
    "no_rows", found, []);
}
