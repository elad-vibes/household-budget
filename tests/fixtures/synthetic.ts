// SYNTHETIC test data only. Every name, merchant, amount and date here is
// invented. This folder is the only place the pre-commit scan allows
// person-like data (see scripts/precommit-scan.mjs).

export const NAMES = {
  a1: "דנה", a2: "יואב", kid: "נועה", b1: "רון", grandma: "סבתא",
  hhA: "בית א", hhB: "בית ב",
};

/** Minimal windows-1255 encoder (ASCII + Hebrew letters + ₪) for bank CSVs. */
export function win1255(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x05d0 && c <= 0x05ea) out.push(0xe0 + (c - 0x05d0));
    else if (c === 0x20aa) out.push(0xa4);
    else out.push(0x3f);
  }
  return Uint8Array.from(out);
}

// Max-like: preamble, header row, billed amounts ("סכום חיוב"), installments, a total row.
export const MAX_CSV = "﻿" + [
  "כרטיס: 1234 (מספר לדוגמה),,,,,",
  "עסקאות במועד החיוב,,,,,",
  "תאריך עסקה,שם בית העסק,קטגוריה,סוג עסקה,סכום חיוב,הערות",
  "03-08-2026,סופר השכונה,מזון,רגילה,312.40,",
  "05-08-2026,הראל ביטוח בריאות,ביטוח,הוראת קבע,89.00,",
  "12-03-2026,חנות אלקטרוניקה,מוצרי חשמל,תשלומים,250.00,תשלום 6 מתוך 12",
  "14-08-2026,וולט,מסעדות,רגילה,74.90,",
  "20-08-2026,חנות בגדים,ביגוד,זיכוי,-120.00,",
  "21-08-2026,נטפליקס,מנויים,רגילה,54.90,",
  ",סה\"כ לחיוב,,,661.20,",
].join("\r\n");

// Isracard-like: "תאריך רכישה", "שם בית עסק", original vs billed amount, "פירוט נוסף".
export const ISRACARD_CSV = [
  "תאריך רכישה,שם בית עסק,סכום עסקה,מטבע מקור,סכום חיוב,מטבע לחיוב,פירוט נוסף",
  "02/08/26,פז תחנת דלק,280.00,ש\"ח,280.00,ש\"ח,",
  "09/08/26,סופר פארם,65.50,ש\"ח,65.50,ש\"ח,",
  "15/08/26,AMAZON MKTPLACE,30.00,$,109.20,ש\"ח,",
  "10/06/26,רהיטים בע\"מ,3000.00,ש\"ח,500.00,ש\"ח,תשלום 3 מתוך 6",
].join("\n");

// Bank-like (Hapoalim/Leumi style; encoded windows-1255 by the test): debit/credit columns.
export const BANK_CSV = [
  "תאריך,תיאור הפעולה,אסמכתא,חובה,זכות,יתרה",
  "01/08/2026,משכורת,1001,,14500.00,20000.00",
  "02/08/2026,חיוב ישראכרט,1002,3240.10,,16759.90",
  "05/08/2026,חברת החשמל,1003,412.30,,16347.60",
  "10/08/2026,העברה לחשבון חיסכון,1004,1000.00,,15347.60",
  "15/08/2026,משיכת מזומן כספומט,1005,300.00,,15047.60",
].join("\r\n");

// Discount-like: one signed column "₪ זכות/חובה" (negative = money out) and the common "תאור" spelling.
export const DISCOUNT_CSV = [
  "תאריך,יום ערך,תאור,₪ זכות/חובה,₪ יתרה",
  "03/08/2026,03/08/2026,ביטוח לאומי קצבת ילדים,173.00,5173.00",
  "06/08/2026,06/08/2026,תאגיד מים,-148.20,5024.80",
  "09/08/2026,09/08/2026,ועד בית,-250.00,4774.80",
].join("\n");

export const NO_COLUMNS_CSV = "שם,טלפון\nדנה,לא רלוונטי";
export const EMPTY_ROWS_CSV = "תאריך עסקה,שם בית העסק,סכום חיוב\n,,\nסה\"כ,,0";
