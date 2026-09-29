// Payment methods + no double counting, end to end (payment-methods.md), 390px,
// live Supabase with the synthetic fixture: a card expense and a cash expense are
// logged, then a synthetic card statement is imported → the card expense is merged
// (one row, statement amount), cash stays, and the month total is not doubled.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const d = (day: number) => `${ym}-${String(day).padStart(2, "0")}`;
const dmy = (day: number) => `${String(day).padStart(2, "0")}/${ym.slice(5, 7)}/${ym.slice(0, 4)}`;

async function heroTotal(page: Page): Promise<number> {
  await page.locator(".bnav").getByRole("button", { name: "סקירה" }).click();
  // the hero counts up; its target value is in data-countup (whole shekels)
  return Number(await page.locator(".hero .big").getAttribute("data-countup"));
}

async function addManual(page: Page, merchant: string, amount: string, day: number, method: RegExp) {
  await page.locator(".bnav").getByRole("button", { name: "הוספה" }).click();
  await page.locator("#mDate").fill(d(day));
  await page.locator("#mAmt").fill(amount);
  await page.locator("#mDesc").fill(merchant);
  await page.getByRole("radiogroup", { name: "איך שילמת?" }).getByRole("radio", { name: method }).click();
  await page.locator('form[data-submit="manual"] button[type="submit"]').click();
  await expect(page.getByText(`✓ נוסף: ${merchant}`)).toBeVisible();
}

test.describe("payment methods (live Supabase, synthetic data)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("card receipt merged into the imported statement, cash stays, nothing counted twice", async ({ page }) => {
    const f = fixture()!;
    await page.addInitScript((s) => {
      localStorage.setItem("hb2-auth", s as string);
      localStorage.setItem("hb2-onboarded", "1");
    }, JSON.stringify(f.member));
    await page.goto("./#/home");
    await expect(page.getByRole("heading", { name: "אמצעי תשלום", exact: true })).toBeVisible({ timeout: 20_000 });

    // 1. a card: type, name, issuer, last 4 digits only
    await page.locator("#pmType").selectOption("credit_card");
    await page.locator("#pmLabel").fill("מקס בדיקה");
    await page.locator("#pmIssuer").fill("מקס");
    await page.locator("#pmLast4").fill("1111");
    await page.getByRole("button", { name: "שמירה" }).last().click();
    await expect(page.getByText("✓ נשמר: מקס בדיקה")).toBeVisible();

    const before = await heroTotal(page);

    // 2. one card expense, one cash expense
    await addManual(page, "מאפיית הכיכר", "120.50", 10, /מקס בדיקה/);
    await addManual(page, "שוק האיכרים", "64", 10, /מזומן/);
    await page.locator(".bnav").getByRole("button", { name: "תנועות" }).click();
    const bakery = page.locator(".tx", { hasText: "מאפיית הכיכר" });
    await expect(bakery).toHaveCount(1);
    await expect(bakery.getByText("ממתין לפירוט")).toBeVisible();
    await expect(page.locator(".tx", { hasText: "שוק האיכרים" }).getByText("ממתין לפירוט")).toHaveCount(0);
    expect(Math.abs((await heroTotal(page)) - (before + 120.5 + 64))).toBeLessThanOrEqual(1); // the hero shows whole shekels

    // 3. import a synthetic card statement (the file says "…1111", so the card is picked by itself)
    const csv = [
      "פירוט עסקאות כרטיס המסתיים ב-1111",
      "תאריך עסקה,שם בית העסק,סכום חיוב",
      `${dmy(11)},מאפיית הכיכר בע"מ,121.00`,
      `${dmy(12)},דמי כרטיס,12.00`,
      `${dmy(20)},חניון העירייה,18.00`,
    ].join("\n");
    await page.locator(".bnav").getByRole("button", { name: "הוספה" }).click();
    await page.locator('select[data-change="st-month"]').selectOption(ym);
    await page.locator("#stFiles").setInputFiles({ name: "max-1111.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await expect(page.locator('select[data-change="rv-method"]')).toHaveValue(/.+/);
    await expect(page.getByText("✓ קבלה אחת הותאמה לפירוט.")).toBeVisible();
    await expect(page.getByText("מתאחד עם הוצאה שנרשמה")).toBeVisible();
    await page.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(page.getByText(/✓ נשמרו 2 תנועות · קבלה אחת הותאמה לפירוט/)).toBeVisible();

    // 4. one bakery row with the statement amount, cash untouched, total = +121 +64 +12 +18 (not +120.5 twice)
    await page.locator(".bnav").getByRole("button", { name: "תנועות" }).click();
    await expect(bakery).toHaveCount(1);
    await expect(bakery).toContainText("₪121.00");
    await expect(bakery.getByText("ממתין לפירוט")).toHaveCount(0);
    await expect(page.locator(".tx", { hasText: "שוק האיכרים" })).toHaveCount(1);
    expect(Math.abs((await heroTotal(page)) - (before + 121 + 64 + 12 + 18))).toBeLessThanOrEqual(1); // the hero shows whole shekels
    await expect(page.getByRole("heading", { name: "לפי אמצעי תשלום" })).toBeVisible();
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
  });

  test("statement upload: a row whose date disagrees with the declared month is flagged and blocks save until resolved (bugs.md)", async ({ page }) => {
    const f = fixture()!;
    await page.addInitScript((s) => {
      localStorage.setItem("hb2-auth", s as string);
      localStorage.setItem("hb2-onboarded", "1");
    }, JSON.stringify(f.member));
    await page.goto("./#/add");
    await expect(page.locator('select[data-change="st-month"]')).toBeVisible({ timeout: 20_000 });

    // the row's real date is last month, but the uploader (wrongly, or the AI reads it wrong) declares THIS month
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const pym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const pdmy = `15/${pym.slice(5, 7)}/${pym.slice(0, 4)}`;
    const merchant = `בדיקת אי-התאמה ${Date.now().toString(36)}`;
    const csv = ["תאריך עסקה,שם בית העסק,סכום חיוב", `${pdmy},${merchant},77.00`].join("\n");

    // the file input stays disabled until a month is declared
    await expect(page.locator("#stFiles")).toBeDisabled();
    await page.locator('select[data-change="st-month"]').selectOption(ym);
    await expect(page.locator("#stFiles")).toBeEnabled();
    await page.locator("#stFiles").setInputFiles({ name: "mismatch.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });

    const row = page.locator("tr", { hasText: merchant });
    await expect(row).toHaveClass(/mismatch/);
    await expect(page.getByText(/בתאריך שלא מתאים לחודש שבחרת/)).toBeVisible();
    await expect(row.getByRole("button", { name: "נכון בכל זאת" })).toBeVisible(); // the other resolution path (not exercised here)
    await page.locator('select[data-change="rv-method"]').selectOption("none");

    // blocked: nothing is saved while the row is unresolved
    await page.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(page.getByText(/יש שורות עם תאריך שלא מתאים/)).toBeVisible();

    // resolved by fixing the date to actually fall in the declared month
    await row.locator('input[type="date"]').fill(`${ym}-15`);
    await expect(row).not.toHaveClass(/mismatch/);
    await page.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(page.getByText(/✓ נשמרו 1 תנועות/)).toBeVisible();

    await page.locator(".bnav").getByRole("button", { name: "תנועות" }).click();
    await expect(page.locator(".tx", { hasText: merchant })).toContainText("₪77.00");

    const { createClient } = await import("@supabase/supabase-js");
    const { loadEnv } = await import("../../scripts/lib/env.mjs");
    const env = loadEnv();
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await admin.from("transactions").delete().eq("household_id", f.householdId).eq("merchant", merchant);
  });
});
