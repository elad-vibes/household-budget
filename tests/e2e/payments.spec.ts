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
  const t = await page.locator(".hero .big").innerText();
  return Number(t.replace(/[^\d.-]/g, ""));
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
});
