// 0016: household region. Pure-function tests: the Israeli behavior is pinned (regression), the Thai one is new.
import { afterEach, describe, expect, it } from "vitest";
import { ALLCATS, CATS, catOf, catsFor, EXCL, isKnownCat } from "../../src/domain/categories";
import { issuerInText, issuersFor, TH_BANKS } from "../../src/domain/banks";
import { crossRate, fmtRate, symbolOf, travelCurrencies } from "../../src/domain/fx";
import { eligible, awaitsStatement, detectMethod, isAtmRow, PM_TYPES, type PaymentMethod } from "../../src/domain/match";
import { decodeCsv, parseDate, parseSheets, type Sheet } from "../../src/domain/parser";
import { ils } from "../../src/lib/format";
import { baseCode, baseLabel, baseSymbol, baseWordTo, region, regionCode, setRegion } from "../../src/lib/region";
import { isRegion, regionOf, REGIONS } from "../../supabase/functions/_shared/region";
import { analysisPrompt, analysisSchemaFor, israelDateStr, receiptPrompt, receiptSchemaFor, statementPrompt, statementSchemaFor } from "../../supabase/functions/_shared/prompts";
import { linkIdsFor } from "../../supabase/functions/_shared/catalog";
import { sanitizeStatement } from "../../supabase/functions/_shared/ai";

afterEach(() => setRegion("IL"));

describe("the region table", () => {
  it("unknown or missing is Israel (the pre-0016 behavior)", () => {
    for (const x of [undefined, null, "", "il", "XX", 5]) expect(regionOf(x).code).toBe("IL");
    expect(isRegion("TH")).toBe(true);
    expect(isRegion("th")).toBe(false);
  });
  it("IL = ₪ / Asia/Jerusalem / price comparison on; TH = ฿ / Asia/Bangkok / price comparison off", () => {
    expect(REGIONS.IL).toMatchObject({ currency: "ILS", symbol: "₪", tz: "Asia/Jerusalem", priceCompare: true, weeklyDay: 0 });
    expect(REGIONS.TH).toMatchObject({ currency: "THB", symbol: "฿", tz: "Asia/Bangkok", priceCompare: false, weeklyDay: 1 });
  });
  it("the running app starts in Israel and follows setRegion", () => {
    expect([regionCode(), baseCode(), baseSymbol(), baseWordTo(), baseLabel()]).toEqual(["IL", "ILS", "₪", "לשקלים", "₪ שקל"]);
    setRegion("TH");
    expect([regionCode(), baseCode(), baseSymbol(), baseWordTo(), baseLabel(), region().smallPurchase]).toEqual(["TH", "THB", "฿", "לבאט", "฿ באט", 600]);
    setRegion("garbage");
    expect(regionCode()).toBe("IL");
  });
});

describe("amounts in the base currency", () => {
  it("Israel prints exactly what it always printed", () => {
    expect(ils(1234)).toBe("₪1,234");
    expect(ils(-45.5, 2)).toBe("-₪45.50");
  });
  it("Thailand prints the baht sign", () => {
    setRegion("TH");
    expect(ils(1234)).toBe("฿1,234");
    expect(ils(-45.5, 2)).toBe("-฿45.50");
  });
  it("a rate line is quoted in the base; the trip currencies exclude the base", () => {
    expect(fmtRate(0.0911, "THB")).toBe("1 ฿ = ₪0.0911");
    expect(travelCurrencies().some((c) => c.code === "ILS")).toBe(false);
    expect(travelCurrencies().some((c) => c.code === "THB")).toBe(true);
    setRegion("TH");
    expect(fmtRate(10.976948, "ILS")).toBe("1 ₪ = ฿10.98");
    expect(travelCurrencies().some((c) => c.code === "THB")).toBe(false);
    expect(travelCurrencies()[0].code).toBe("ILS");
    expect(symbolOf("ILS")).toBe("₪");
  });
  it("cross rate through the shekel (the SQL rule); base ILS leaves the cached rate untouched", () => {
    expect(crossRate(3.078, 1)).toBe(3.078);
    expect(crossRate(3.078, 0.0911, "THB")).toBeCloseTo(33.787, 3);
    expect(crossRate(1, 0.0911, "THB")).toBeCloseTo(10.976948, 6);
  });
});

describe("categories and rules", () => {
  it("Israel's category list is exactly what it was; Thailand adds two and removes none", () => {
    expect(catsFor("IL")).toEqual(CATS);
    expect(catsFor(undefined)).toEqual(CATS);
    expect(CATS).toHaveLength(21);
    expect(catsFor("TH")).toEqual([...CATS, "ויזה ואישורי שהייה", "מרכזים מסחריים"]);
    expect(isKnownCat("ויזה ואישורי שהייה")).toBe(true);
    expect(isKnownCat("לא קיימת")).toBe(false);
    expect(ALLCATS).toEqual([...CATS, ...EXCL]);
  });

  it("Israeli merchants are categorized exactly as before, with or without the region argument", () => {
    const il: [string, string][] = [["שופרסל דיל", "סופר ומכולת"], ["סופר פארם", "בריאות ופארם"], ["חברת החשמל", "חשבונות בית"], ["wolt", "אוכל בחוץ ומשלוחים"],
      ["ביט תשלום", "העברות ומזומן"], ["נטפליקס", "תקשורת ומנויים"], ["משיכת מזומן", "משיכת מזומן"], ["7-Eleven", "שונות"], ["Grab", "שונות"], ["Lotus's", "שונות"]];
    for (const [m, c] of il) {
      expect(catOf(m).category, m).toBe(c);
      expect(catOf(m, "IL").category, m).toBe(c);
    }
  });

  it("Thailand: groceries, rides, delivery, rent, utilities, visa, insurance, malls, banks", () => {
    const th: [string, string, boolean][] = [
      ["7-Eleven Sukhumvit", "סופר ומכולת", false], ["Lotus's Rama 4", "סופר ומכולת", false], ["BIG C EXTRA", "סופר ומכולת", false], ["Makro Chiang Mai", "סופר ומכולת", false],
      ["Tops Market", "סופר ומכולת", false], ["Grab* A-12345", "תחבורה ציבורית", false], ["Bolt ride", "תחבורה ציבורית", false], ["BTS Skytrain", "תחבורה ציבורית", false],
      ["GrabFood", "אוכל בחוץ ומשלוחים", false], ["foodpanda", "אוכל בחוץ ומשלוחים", false], ["LINE MAN Wongnai", "אוכל בחוץ ומשלוחים", false],
      ["Condo rent Oct", "דיור (שכירות/משכנתא)", true], ["ค่าเช่า คอนโด", "דיור (שכירות/משכנתא)", true], ["Juristic person common fee", "דיור (שכירות/משכנתא)", true],
      ["MEA electricity bill", "חשבונות בית", true], ["การประปานครหลวง", "חשבונות בית", true], ["AIS Fibre", "תקשורת ומנויים", true], ["True Move H", "תקשורת ומנויים", true],
      ["Visa extension fee", "ויזה ואישורי שהייה", false], ["TM30 notification", "ויזה ואישורי שהייה", false], ["90 day report", "ויזה ואישורי שהייה", false], ["Immigration Bureau", "ויזה ואישורי שהייה", false],
      ["AIA health insurance", "ביטוחים", true], ["Bumrungrad Hospital", "בריאות ופארם", false], ["Boots pharmacy", "בריאות ופארם", false],
      ["CentralWorld", "מרכזים מסחריים", false], ["Siam Paragon", "מרכזים מסחריים", false], ["Terminal 21", "מרכזים מסחריים", false],
      ["PTT Station", "רכב, דלק וחניה", false], ["Lazada", "קניות אונליין", false], ["ATM cash withdrawal", "משיכת מזומן", false],
      ["PromptPay transfer", "העברות ומזומן", false], ["Salary October", "הכנסה", false], ["Credit card payment KBank", "חיוב אשראי מרוכז", false],
    ];
    for (const [m, c, fixed] of th) expect(catOf(m, "TH"), m).toEqual({ category: c, fixed });
    // the Israeli rules still apply underneath (Netflix, Booking, Hebrew words)
    expect(catOf("Netflix", "TH").category).toBe("תקשורת ומנויים");
    expect(catOf("zzz unknown shop", "TH").category).toBe("שונות");
  });

  it("'current' is not 'rent', 'coffee' is not a fee (word boundaries)", () => {
    expect(catOf("current account", "TH").category).not.toBe("דיור (שכירות/משכנתא)");
    expect(catOf("Coffee Club", "TH").category).toBe("אוכל בחוץ ומשלוחים");
  });
});

describe("payment methods and banks", () => {
  const m = (o: Partial<PaymentMethod>): PaymentMethod => ({ id: "x", type: "bank_transfer", label: "x", issuer: "", last4: null, person_id: null, active: true, sort: 1, ...o });
  it("the Thai bank list is the nine requested, within the 30-character issuer limit", () => {
    expect(TH_BANKS.map((b) => b.name)).toEqual(["Kasikorn (KBank)", "SCB", "Bangkok Bank", "Krungthai", "Krungsri", "TMBThanachart (ttb)", "UOB", "CIMB Thai", "Government Savings Bank"]);
    for (const i of issuersFor("TH")) expect(i.length).toBeLessThanOrEqual(30);
    expect(issuersFor("IL")).toContain("מקס");
    expect(issuersFor("IL")).not.toContain("SCB");
    expect(issuersFor("TH")).not.toContain("מקס");
  });
  it("a bank is found by its other spellings (Latin and Thai)", () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9฀-๿֐-׿]/g, "");
    expect(issuerInText("Kasikorn (KBank)", "KBANK statement Oct 2026", norm)).toBe(true);
    expect(issuerInText("Kasikorn (KBank)", "ธนาคารกสิกรไทย", norm)).toBe(true);
    expect(issuerInText("SCB", "SCB EASY export", norm)).toBe(true);
    expect(issuerInText("Krungsri", "ธนาคารกรุงศรี", norm)).toBe(true);
    expect(issuerInText("מקס", "פירוט מקס", norm)).toBe(true);
    expect(issuerInText("", "anything", norm)).toBe(false);
  });
  it("an e-wallet waits for its statement like a card and is matched by its issuer; detectMethod finds a Thai bank file", () => {
    expect(PM_TYPES.e_wallet).toBeTruthy();
    expect(awaitsStatement("e_wallet")).toBe(true);
    const a = m({ id: "a", type: "e_wallet", label: "TrueMoney Wallet", issuer: "TrueMoney" });
    expect(eligible(a, a, "7-Eleven")).toBe(true);
    expect(eligible(a, m({ id: "b", type: "e_wallet", label: "Rabbit LINE Pay", issuer: "Rabbit LINE Pay" }), "7-Eleven")).toBe(false);
    const kb = m({ id: "k", type: "debit_card", label: "KBank debit", issuer: "Kasikorn (KBank)" });
    expect(detectMethod("KBANK_statement_2026-10.csv", [kb, a])?.id).toBe("k");
    expect(isAtmRow("ATM cash withdrawal")).toBe(true);
    expect(isAtmRow("ถอนเงินสด")).toBe(true);
  });
});

describe("importing a statement without guessing a bank's format", () => {
  it("Buddhist-era years become Gregorian ones; Gregorian files are untouched", () => {
    expect(parseDate("26/10/2569")).toBe("2026-10-26");
    expect(parseDate("2569-10-26")).toBe("2026-10-26");
    expect(parseDate("26/10/2026")).toBe("2026-10-26");
    expect(parseDate("2026-10-26")).toBe("2026-10-26");
    expect(parseDate("26/10/26")).toBe("2026-10-26");
  });
  it("a TIS-620 / windows-874 CSV is decoded for a Thai household and stays windows-1255 for an Israeli one", () => {
    const thai874 = new Uint8Array([0xB5, 0xC5, 0xD2, 0xB4]);   // "ตลาด" in TIS-620
    expect(decodeCsv(thai874.buffer, REGIONS.TH.csvEncodings)).toBe("ตลาด");
    const hebrew1255 = new Uint8Array([0xF9, 0xEC, 0xE5, 0xED]);   // "שלום"
    expect(decodeCsv(hebrew1255.buffer)).toBe("שלום");
    expect(decodeCsv(new TextEncoder().encode("ตลาด").buffer as ArrayBuffer)).toBe("ตลาด");   // UTF-8 first, always
  });
  const sheet = (header: string[], rows: (string | number)[][]): Sheet => [["Account statement"], [], header, ...rows];
  it("generic English headers work (Date / Description / Withdrawal / Deposit)", () => {
    const r = parseSheets([sheet(["Date", "Description", "Withdrawal", "Deposit"],
      [["26/10/2569", "7-Eleven Silom", "120.50", ""], ["27/10/2569", "SALARY OCT", "", "45,000.00"]])], "stmt.xlsx");
    expect(r.docType).toBe("bank");
    expect(r.rows.map((x) => [x.date, x.merchant, x.amount, x.category])).toEqual([
      ["2026-10-26", "7-Eleven Silom", 120.5, "שונות"],       // IL region: the Thai rules are not applied
      ["2026-10-27", "SALARY OCT", 45000, "הכנסה"],
    ]);
  });
  it("generic Thai headers work, and a Thai household categorizes with the Thai rules", () => {
    setRegion("TH");
    const r = parseSheets([sheet(["วันที่", "รายการ", "ถอน", "ฝาก"],
      [["26/10/2569", "Grab* 12345", "85.00", ""], ["27/10/2569", "โลตัส พระราม 4", "640.00", ""]])], "สเตทเมนต์.csv");
    expect(r.rows.map((x) => [x.date, x.amount, x.category])).toEqual([["2026-10-26", 85, "תחבורה ציבורית"], ["2026-10-27", 640, "סופר ומכולת"]]);
  });
  it("a file with unknown headers still fails loudly (no silent zero rows)", () => {
    expect(() => parseSheets([[["colA", "colB", "colC"], ["1", "2", "3"]]], "x.csv")).toThrow();
  });
});

describe("AI prompts and schemas per region", () => {
  const today = "2026-10-28";
  it("Israel's prompts are the Israeli ones", () => {
    const r = receiptPrompt(today);
    expect(r).toContain("משק בית בישראל");
    expect(r).toContain("ILS לשקלים");
    expect(r).toContain("היום בישראל הוא 2026-10-28");
    expect(r).toBe(receiptPrompt(today, "IL"));
    const s = statementPrompt("x", [], today);
    expect(s).toContain("משק בית בישראל");
    expect(s).toContain('הסכום בשקלים שחויב בפועל (עמודת "סכום חיוב")');
    expect(s).toContain("ישראכרט");
    expect(analysisPrompt("sum")).toContain("השוק הישראלי");
    expect(receiptSchemaFor("IL").properties.category.enum).toEqual([...CATS]);
    expect(statementSchemaFor("IL").properties.rows.items.properties.category.enum).toEqual([...ALLCATS]);
    expect(analysisSchemaFor("IL").properties.tips.items.properties.links.items.enum).toHaveLength(13);
  });
  it("Thailand's prompts say Thailand, baht, Buddhist years, PromptPay and no Israeli links", () => {
    const r = receiptPrompt(today, "TH");
    expect(r).toContain("משק בית בתאילנד");
    expect(r).toContain("אם אין סימן מטבע וזו קבלה תאילנדית, THB");
    expect(r).toContain("PromptPay");
    expect(r).toContain("היום בתאילנד הוא 2026-10-28");
    expect(r).toContain("2569 = 2026");
    const s = statementPrompt("x", [], today, "TH");
    expect(s).toContain("הסכום בבאט (THB) שחויב בפועל");
    expect(s).toContain("Withdrawal");
    expect(s).not.toContain("ישראכרט");
    const a = analysisPrompt("sum", "TH");
    expect(a).toContain("בתאילנד");
    expect(a).not.toContain("הר הביטוח");
    expect(linkIdsFor("TH")).toEqual(["apple_subs", "netflix", "disney", "spotify"]);
    expect(analysisSchemaFor("TH").properties.tips.items.properties.links.items.enum).toEqual(linkIdsFor("TH"));
    expect(receiptSchemaFor("TH").properties.category.enum).toContain("ויזה ואישורי שהייה");
    expect(statementSchemaFor("TH").properties.rows.items.properties.category.enum).toContain("מרכזים מסחריים");
    expect(statementSchemaFor("TH").properties.rows.items.properties.category.enum).toContain("משיכת מזומן");
  });
  it("today is the date in the household's time zone", () => {
    const d = new Date("2026-10-27T18:30:00Z");   // 20:30 in Israel (UTC+2), 01:30 the next day in Bangkok (UTC+7)
    expect(israelDateStr(d)).toBe("2026-10-27");
    expect(israelDateStr(d, "IL")).toBe("2026-10-27");
    expect(israelDateStr(d, "TH")).toBe("2026-10-28");
  });
  it("a statement row 'foreign' in the household's own base is not a foreign row", () => {
    const row = (cur: string) => ({ rows: [{ date: "2026-10-26", month: "2026-10", merchant: "m", amount: 100, original_amount: 10, original_currency: cur }] });
    expect(sanitizeStatement(row("THB"), "THB").rows[0].original_currency).toBeUndefined();
    expect(sanitizeStatement(row("ILS"), "THB").rows[0].original_currency).toBe("ILS");
    expect(sanitizeStatement(row("ILS")).rows[0].original_currency).toBeUndefined();
    expect(sanitizeStatement(row("THB")).rows[0].original_currency).toBe("THB");
  });
});
