// "איפה הכי זול?" on the shopping list (next-features.md §1), 390px, live Supabase +
// synthetic fixture. The price-compare function is intercepted with fixed answers, so the
// test is deterministic and never calls SuperMCP: ask-once address → ranked chains →
// per-item details → "פריט דומה"; and the fallback links when the service is down.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
const RESULT = {
  status: "complete", city: "עיר לדוגמה", cheapest: "store-a", fetchedAt: new Date().toISOString(), source: "SuperMCP",
  items: [{ i: 0, q: "חלב", name: "חלב 3% 1 ליטר", resolved: true }, { i: 1, q: "לחם", name: "לחם אחיד", resolved: true }],
  stores: [
    { slug: "store-a", brand: "רשת א אונליין", chain: "רשת א", total: 71.03, comparable: 71.03, items: 41.13, fee: 29.9, feeFloor: false,
      meetsMinimum: true, toMinimum: null, found: 1, lines: 2, url: "https://store-a.example.test/", asOf: null,
      rows: [{ i: 0, name: "חלב 3% 1 ליטר", qty: 2, price: 12.82, sub: false, promo: true, club: false }], missing: [{ i: 1, q: "לחם" }] },
    { slug: "store-b", brand: "רשת ב", chain: "רשת ב", total: null, comparable: 88.4, items: 52.5, fee: null, feeFloor: false,
      meetsMinimum: false, toMinimum: 17.5, found: 2, lines: 2, url: null, asOf: null, rows: [], missing: [] },
  ],
};

async function route(page: Page, mode: "ok" | "down") {
  await page.route("**/functions/v1/price-compare", async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    const body = r.request().postDataJSON();
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (mode === "down") return r.fulfill({ status: 502, headers, body: JSON.stringify({ error: "service_down", message: "השוואת המחירים לא זמינה כרגע." }) });
    if (body.similar) return r.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, similar: [{ name: "לחם קל פרוס", brand: "דוגמה" }] }) });
    return r.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, cached: false, result: RESULT }) });
  });
}

test.describe("price compare (live Supabase, synthetic data, intercepted function)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("ask the address once → ranked chains → details → similar item", async ({ page }) => {
    await page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.member));
    await route(page, "ok");
    await page.goto("./#/shop");
    const card = page.locator("#priceCard");
    await expect(card.getByRole("heading", { name: "איפה הכי זול?" })).toBeVisible({ timeout: 20_000 });
    await card.locator("#pcCity").fill("עיר לדוגמה");
    await card.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("✓ נשמר. אפשר להשוות.")).toBeVisible();
    await card.getByRole("button", { name: "איפה הכי זול?" }).click();
    const first = card.locator(".pstore").first();
    await expect(first).toContainText("רשת א אונליין");
    await expect(first).toContainText("₪71.03");
    await expect(first.locator(".chip.save")).toHaveText("הכי זול");
    await expect(card.locator(".pstore").nth(1)).toContainText("חסר ₪17.50 למינימום");
    await expect(card.locator(".pstore").nth(1)).toContainText("דמי משלוח לא ידועים");
    await expect(card).toContainText("מחירים מ-SuperMCP");
    await first.locator("summary").click();
    await expect(first).toContainText("חלב 3% 1 ליטר × 2");
    await first.getByRole("button", { name: "פריט דומה" }).click();
    await expect(first).toContainText("אולי: לחם קל פרוס");
    await expect(first).toHaveAttribute("open", "");   // stays open across re-renders
    await expect(page.locator(".flash")).toHaveCount(0, { timeout: 6000 });
    if (process.env.SHOTS === "after") await page.screenshot({ path: "docs/features/1-price-compare/after/shop-result.png", fullPage: true, animations: "disabled" });
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
  });

  test("service down → a clear message and the comparison links", async ({ page }) => {
    await page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.member));
    await route(page, "down");
    await page.goto("./#/shop");
    const card = page.locator("#priceCard");
    await expect(card.getByRole("button", { name: "איפה הכי זול?" })).toBeVisible({ timeout: 20_000 }); // address saved by the first test
    await card.getByRole("button", { name: "איפה הכי זול?" }).click();
    await expect(card.locator(".banner.warn")).toContainText("לא זמינה כרגע");
    await expect(card.getByRole("link", { name: /CHP/ })).toBeVisible();
  });
});
