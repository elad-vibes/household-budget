// The pre-commit scan itself. Sensitive-looking values are BUILT at runtime so
// this file never contains a literal card number, ID, key or e-mail.
import { describe, expect, it } from "vitest";
import { israeliId, luhn, scanPath, scanText } from "../../scripts/precommit-scan.mjs";

function withLuhn(prefix: string): string {
  for (let d = 0; d < 10; d++) if (luhn(prefix + d)) return prefix + d;
  throw new Error("unreachable");
}
function withIdCheck(prefix8: string): string {
  for (let d = 0; d < 10; d++) if (israeliId(prefix8 + d)) return prefix8 + d;
  throw new Error("unreachable");
}
const kinds = (text: string, path = "src/x.ts", names: string[] = []) => scanText(text, { path, names }).map((f: { kind: string }) => f.kind);

describe("pre-commit scan", () => {
  it("blocks secrets everywhere, even in fixtures", () => {
    const supa = "sb_" + "secret_" + "Ab1".repeat(8);
    const ant = "sk-" + "ant-" + "api03-" + "Zz9".repeat(10);
    const jwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
    expect(kinds(`const k = "${supa}"`)).toContain("מפתח סודי של Supabase");
    expect(kinds(`key: ${ant}`, "tests/fixtures/x.ts")).toContain("מפתח Anthropic");
    expect(kinds(`Authorization: Bearer ${jwt}`)).toContain("JWT");
  });

  it("blocks values copied from .env.local without printing them", () => {
    const value = "super-" + "private-value-123";
    const f = scanText(`x = "${value}"`, { path: "README.md", envValues: [{ key: "SUPABASE_DB_PASSWORD", value }] });
    expect(f).toEqual([{ kind: "ערך מ-.env.local", value: "SUPABASE_DB_PASSWORD" }]);
  });

  it("blocks card numbers (Luhn), Israeli IDs (check digit), bank accounts, phones and e-mails outside fixtures", () => {
    const card = withLuhn("453201511283036");
    const spaced = card.replace(/(\d{4})(?=\d)/g, "$1 ");
    const id = withIdCheck("30172839");
    expect(kinds(`כרטיס ${spaced}`)).toContain("מספר כרטיס אפשרי");
    expect(kinds(`ת"ז ${id}`)).toContain("מספר ת\"ז אפשרי");
    expect(kinds(`חשבון ${"12" + "-345-" + "678901"}`)).toContain("מספר חשבון בנק אפשרי");
    expect(kinds(`נייד ${"05" + "2-555-" + "1234"}`)).toContain("מספר טלפון");
    expect(kinds(`mail ${"someone" + "@" + "gmail.com"}`)).toContain("כתובת מייל");
    // …but synthetic data in tests/fixtures/ is allowed
    expect(kinds(`כרטיס ${spaced} ת"ז ${id}`, "tests/fixtures/sample.ts")).toEqual([]);
  });

  it("does not flag ordinary code: uuids, example e-mails, co-author lines, amounts, dates", () => {
    const code = [
      `const H = "00000000-0000-4000-8000-0000000000aa";`,
      `insert into auth.users values ('x', 'owner.a@example.test');`,
      `Co-Authored-By: Claude <noreply@anthropic.com>`,
      `amount: 312.40, date: "2026-08-03", big: 5242880, ts: 1727350000000`,
      `"@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@0.128.0"`,
    ].join("\n");
    expect(kinds(code)).toEqual([]);
  });

  it("blocks real names from the local denylist (outside fixtures) unless the line says scan-ok", () => {
    expect(kinds(`placeholder="שם (למשל: אורית)"`, "src/ui/home.ts", ["אורית"])).toContain("שם אמיתי מהמערכת");
    expect(kinds(`placeholder="שם (למשל: אורית)" // scan-ok`, "src/ui/home.ts", ["אורית"])).toEqual([]);
    expect(kinds(`name: "אורית"`, "tests/fixtures/synthetic.ts", ["אורית"])).toEqual([]);
    expect(kinds(`אוריתה`, "src/a.ts", ["אורית"])).toEqual([]); // whole words only
  });

  it("blocks data files and backups outside fixtures", () => {
    expect(scanPath("exports/max-2026-08.xlsx")).toHaveLength(1);
    expect(scanPath("backup.json")).toHaveLength(1);
    expect(scanPath("package.json")).toHaveLength(0);
    expect(scanPath("tests/fixtures/max.csv")).toHaveLength(0);
    const backupLike = "{" + '"format"' + ': "hb-data-v2", "transactions": []}';
    expect(kinds(backupLike, "notes.md")).toContain("קובץ גיבוי עם נתונים");
  });
});
