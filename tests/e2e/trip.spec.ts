// מצב טיול (next-features.md §5), 390px, live Supabase + synthetic fixture (trip mode off,
// two purchases abroad). The fx-rates function is intercepted with fixed rates, so the test is
// deterministic and never calls the Bank of Israel / ECB: the settings card shows the rate →
// a manual add in baht is converted and keeps the original → the list shows ₪ + ฿; and the
// "no rate" message when the function is down.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
const today = new Date().toISOString().slice(0, 10);
const RATES = { ok: true, fetched: "cached", stale: false, lastSuccess: new Date().toISOString(),
  official: { THB: { rate: 0.0905, date: today, source: "ecb" }, USD: { rate: 3.078, date: today, source: "boi" } }, manual: {} };

async function route(page: Page, mode: "ok" | "down") {
  await page.route("**/functions/v1/fx-rates", async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (mode === "down") return r.fulfill({ status: 502, headers, body: JSON.stringify({ error: "fx_down", message: "שערי המטבע לא זמינים כרגע. אפשר להזין שער ידני בהגדרות מצב טיול." }) });
    return r.fulfill({ status: 200, headers, body: JSON.stringify(RATES) });
  });
}
const signIn = (page: Page) => page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.member));
const noSideScroll = async (page: Page) => {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
};

test.describe("trip mode (live Supabase, synthetic data, intercepted fx-rates)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("settings card → add in baht → ₪ + original in the list", async ({ page }) => {
    await signIn(page);
    await route(page, "ok");
    await page.goto("./#/home");
    const card = page.locator("#tripCard");
    await expect(card.getByRole("heading", { name: "מצב טיול" })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByLabel("מצב טיול פעיל")).not.toBeChecked();
    await card.getByLabel("מצב טיול פעיל").check();          // stays on for the next tests (same fixture)
    await expect(page.locator(".flash")).toContainText("מצב טיול פעיל");
    await expect(card.getByLabel("מצב טיול פעיל")).toBeChecked();
    await expect(card).toContainText("1 ฿ = ₪0.0905");
    await expect(card).toContainText("שער הבנק המרכזי האירופי");
    await noSideScroll(page);
    if (process.env.SHOTS === "after") await card.screenshot({ path: "docs/features/5-trip-mode/after/home-trip-card.png", animations: "disabled" });

    await page.goto("./#/add");
    const form = page.locator("form[data-submit=manual]");
    await expect(form.getByText("סכום (฿)")).toBeVisible({ timeout: 20_000 });
    await form.locator("#mAmt").fill("350");
    await expect(form.locator("#mConv")).toHaveText("≈ ₪31.68");
    await form.locator("#mDesc").fill("פאד תאי ליד המלון");
    await form.locator("#mCat").selectOption("אוכל בחוץ ומשלוחים");
    const cash = form.getByRole("button", { name: "מזומן" });
    if (await cash.count()) await cash.first().click();
    await noSideScroll(page);
    if (process.env.SHOTS === "after") await page.screenshot({ path: "docs/features/5-trip-mode/after/add-trip.png", fullPage: true, animations: "disabled" });
    await form.getByRole("button", { name: "הוספה" }).click();
    await expect(page.locator(".flash")).toContainText("₪31.68 (฿350)");

    await page.goto("./#/tx");
    const row = page.locator(".tx", { hasText: "פאד תאי ליד המלון" });
    await expect(row).toContainText("₪31.68");
    await expect(row.locator(".fxorig")).toContainText("฿350");
    await expect(row.locator(".fxorig")).toContainText("1 ฿ = ₪0.0905");
    await expect(page.locator(".tx", { hasText: "שוק לילה" }).locator(".fxorig")).toContainText("฿350");   // seeded row
    await noSideScroll(page);
    if (process.env.SHOTS === "after") { await page.waitForTimeout(1200); await page.screenshot({ path: "docs/features/5-trip-mode/after/tx.png", fullPage: true, animations: "disabled" }); }
  });

  test("₪ switch in trip mode saves a plain ₪ expense", async ({ page }) => {
    await signIn(page);
    await route(page, "ok");
    await page.goto("./#/add");
    const form = page.locator("form[data-submit=manual]");
    await form.getByRole("button", { name: "₪ שקל" }).click({ timeout: 20_000 });
    await expect(form.getByText("סכום (₪)")).toBeVisible();
    await expect(form.locator("#mConv")).toHaveCount(0);
  });

  test("fx-rates down and no manual rate → a clear message, nothing saved in baht", async ({ page }) => {
    await signIn(page);
    await route(page, "down");
    await page.goto("./#/add");
    const form = page.locator("form[data-submit=manual]");
    await expect(form.getByText("סכום (฿)")).toBeVisible({ timeout: 20_000 });
    await expect(form.locator("#mConv")).toContainText("שער ידני");
    await form.locator("#mAmt").fill("120");
    await form.locator("#mDesc").fill("לא יישמר");
    const cash = form.getByRole("button", { name: "מזומן" });
    if (await cash.count()) await cash.first().click();
    await form.getByRole("button", { name: "הוספה" }).click();
    await expect(page.locator(".flash")).toContainText("אין עדיין שער");
  });
});
