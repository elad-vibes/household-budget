// Parser tests with SYNTHETIC statements shaped like Max, Isracard and Israeli
// bank exports. No real data: merchants are generic, amounts and dates invented.
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { decodeCsv, fileKind, ImportError, localParse, parseAmt, parseDate } from "../../src/domain/parser.ts";
import { BANK_CSV, DISCOUNT_CSV, EMPTY_ROWS_CSV, ISRACARD_CSV, MAX_CSV, NO_COLUMNS_CSV, win1255 } from "../fixtures/synthetic.ts";

const file = (bytes: Uint8Array | string, name: string, type = "text/csv") =>
  new File([(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) as BlobPart], name, { type });

describe("parseDate / parseAmt", () => {
  it("reads Israeli date formats", () => {
    expect(parseDate("03-08-2026")).toBe("2026-08-03");
    expect(parseDate("3/8/26")).toBe("2026-08-03");
    expect(parseDate("2026-08-03")).toBe("2026-08-03");
    expect(parseDate("31.12.2025")).toBe("2025-12-31");
    expect(parseDate("סה\"כ")).toBe("");
    expect(parseDate("45/13/2026")).toBe("");
    expect(parseDate(46237)).toBe("2026-08-03"); // Excel serial
  });
  it("reads amounts with symbols, commas and negatives", () => {
    expect(parseAmt("₪1,234.50")).toBe(1234.5);
    expect(parseAmt("-120.00")).toBe(-120);
    expect(parseAmt("(80)")).toBe(-80);
    expect(parseAmt("")).toBeNaN();
    expect(parseAmt(42)).toBe(42);
  });
});

describe("Max-style card statement (CSV, UTF-8 with BOM)", () => {
  it("finds the header after a preamble, reads billed amounts and skips the total row", async () => {
    const r = await localParse(file(MAX_CSV, "max.csv"));
    expect(r.docType).toBe("credit_card");
    expect(r.rows.map((x) => x.merchant)).toEqual(["סופר השכונה", "הראל ביטוח בריאות", "חנות אלקטרוניקה", "וולט", "חנות בגדים", "נטפליקס"]);
    expect(r.rows.find((x) => x.merchant === "חנות בגדים")!.amount).toBe(-120);
  });
  it("categorizes with the prototype rules and marks fixed expenses", async () => {
    const r = await localParse(file(MAX_CSV, "max.csv"));
    const by = Object.fromEntries(r.rows.map((x) => [x.merchant, x]));
    expect(by["סופר השכונה"].category).toBe("סופר ומכולת");
    expect(by["הראל ביטוח בריאות"]).toMatchObject({ category: "ביטוחים", fixed: true });
    expect(by["וולט"].category).toBe("אוכל בחוץ ומשלוחים");
    expect(by["נטפליקס"].category).toBe("תקשורת ומנויים");
  });
  it("moves installments with an old purchase date into the statement's month", async () => {
    const r = await localParse(file(MAX_CSV, "max.csv"));
    const inst = r.rows.find((x) => x.merchant === "חנות אלקטרוניקה")!;
    expect(inst.note).toBe("תשלום 6 מתוך 12");
    expect(inst.date).toBe("2026-03-12");
    expect(inst.month).toBe("2026-08");
  });
});

describe("Isracard-style card statement", () => {
  it("uses the billed ILS amount, not the original currency amount", async () => {
    const r = await localParse(file(ISRACARD_CSV, "isracard.csv"));
    const amazon = r.rows.find((x) => x.merchant === "AMAZON MKTPLACE")!;
    expect(amazon.amount).toBe(109.2);
    expect(amazon.category).toBe("קניות אונליין");
    expect(r.rows.find((x) => x.merchant === "פז תחנת דלק")!.category).toBe("רכב, דלק וחניה");
    expect(r.rows.find((x) => x.merchant === "סופר פארם")!.category).toBe("בריאות ופארם");
  });
  it("keeps only this month's installment", async () => {
    const r = await localParse(file(ISRACARD_CSV, "isracard.csv"));
    const f = r.rows.find((x) => x.merchant.startsWith("רהיטים"))!;
    expect(f).toMatchObject({ amount: 500, month: "2026-08", note: "תשלום 3 מתוך 6" });
  });
});

describe("bank statement (windows-1255 CSV with debit/credit)", () => {
  it("decodes windows-1255", () => {
    expect(decodeCsv(win1255("תאריך,חובה").buffer as ArrayBuffer)).toBe("תאריך,חובה");
  });
  it("credit → income, card lump sum excluded, bills fixed", async () => {
    const r = await localParse(file(win1255(BANK_CSV), "bank.csv"));
    expect(r.docType).toBe("bank");
    const by = Object.fromEntries(r.rows.map((x) => [x.merchant, x]));
    expect(by["משכורת"]).toMatchObject({ category: "הכנסה", amount: 14500 });
    expect(by["חיוב ישראכרט"].category).toBe("חיוב אשראי מרוכז");
    expect(by["חברת החשמל"]).toMatchObject({ category: "חשבונות בית", fixed: true, amount: 412.3 });
    expect(by["משיכת מזומן כספומט"].category).toBe("העברות ומזומן");
    // bank statements keep each row in its own month
    expect(r.rows.every((x) => x.month === "2026-08")).toBe(true);
  });
});

describe("Excel files", () => {
  it("reads an .xlsx with real date cells", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["פירוט עסקאות"],
      ["תאריך עסקה", "שם בית העסק", "סכום חיוב"],
      [new Date(2026, 7, 4), "מאפה השכונה", 32.5],
      [new Date(2026, 7, 9), "סלקום", 59.9],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "עסקאות");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const r = await localParse(file(new Uint8Array(buf), "card.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ date: "2026-08-04", merchant: "מאפה השכונה", amount: 32.5, category: "אוכל בחוץ ומשלוחים" });
    expect(r.rows[1]).toMatchObject({ category: "תקשורת ומנויים", fixed: true });
  });

});

describe("loud column checks (ported from hub engine/tabular.py)", () => {
  it("a file without the required columns fails and lists the columns it found", async () => {
    const err = await localParse(file(NO_COLUMNS_CSV, "contacts.csv")).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.kind).toBe("missing_columns");
    expect(err.found).toEqual(["שם", "טלפון"]);
    expect(err.missing).toEqual(["תאריך", "בית עסק / תיאור", "סכום"]);
    expect(err.message).toContain("העמודות שנמצאו בקובץ: שם, טלפון");
  });
  it("right columns but zero readable rows is an error, never a silent empty import", async () => {
    const err = await localParse(file(EMPTY_ROWS_CSV, "empty.csv")).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.kind).toBe("no_rows");
    expect(err.message).toContain("כלום לא נשמר");
  });
  it("Discount-style single signed column (and the 'תאור' spelling)", async () => {
    const r = await localParse(file(DISCOUNT_CSV, "discount.csv"));
    expect(r.docType).toBe("bank");
    const by = Object.fromEntries(r.rows.map((x) => [x.merchant, x]));
    expect(by["ביטוח לאומי קצבת ילדים"]).toMatchObject({ category: "הכנסה", amount: 173 });
    expect(by["תאגיד מים"]).toMatchObject({ category: "חשבונות בית", amount: 148.2, fixed: true });
    expect(by["ועד בית"].amount).toBe(250);
  });
});

describe("fileKind", () => {
  it("classifies uploads", () => {
    expect(fileKind({ name: "a.XLSX", type: "" })).toBe("xlsx");
    expect(fileKind({ name: "a.csv", type: "" })).toBe("csv");
    expect(fileKind({ name: "a.pdf", type: "" })).toBe("pdf");
    expect(fileKind({ name: "IMG_1.HEIC", type: "" })).toBe("img");
    expect(fileKind({ name: "x.docx", type: "" })).toBe("other");
  });
});
