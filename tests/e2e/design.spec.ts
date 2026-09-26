// Design-pass interactions at 390px (design-brief.md): category legend → filtered
// transactions, the floating camera and its capture sheet, the dark-mode switch.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));

test.describe("design pass (live Supabase, synthetic data)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("legend opens the category's transactions; capture sheet; dark mode", async ({ page }) => {
    await page.addInitScript((s) => {
      localStorage.setItem("hb2-auth", s as string);
      localStorage.setItem("hb2-onboarded", "1");
    }, JSON.stringify(fixture()!.member));
    await page.goto("./#/overview");
    await expect(page.locator(".donut")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".greet")).toContainText(/בוקר טוב|צהריים טובים|ערב טוב/);

    // legend button → transactions filtered to that category
    await page.locator(".dlegend").getByRole("button", { name: /סופר ומכולת/ }).click();
    await expect(page.getByRole("heading", { name: "תנועות החודש" })).toBeVisible();
    await expect(page.locator('select[data-change="f-cat"]')).toHaveValue("סופר ומכולת");
    await expect(page.locator(".tx .m", { hasText: "חברת החשמל" })).toHaveCount(0);

    // swipe left on a transaction → hidden with an undo toast; "ביטול" brings it back
    const row = page.locator(".tx[data-swipe]").first();
    const name = (await row.locator(".m").innerText()).split("\n")[0];
    await row.evaluate((el) => {
      const r = el.getBoundingClientRect(), y = r.top + r.height / 2;
      const t = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t(300)] }));
      el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [t(200)] }));
      el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [t(150)] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }));
    });
    await expect(page.locator(".toast")).toContainText(`נמחק: ${name}`);
    await expect(page.locator(".tx .m", { hasText: name })).toHaveCount(0);
    await page.locator(".toast").getByRole("button", { name: "ביטול" }).click();
    await expect(page.locator(".tx .m", { hasText: name })).toHaveCount(1);

    // floating camera → capture sheet with the framing guide
    await page.getByRole("button", { name: /צילום קבלה/ }).first().click();
    const sheet = page.getByRole("dialog", { name: "צילום קבלה" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("הקבלה כולה בתוך המסגרת")).toBeVisible();
    await sheet.getByRole("button", { name: "סגירה" }).click();
    await expect(sheet).toHaveCount(0);

    // dark mode (per device)
    await page.locator(".bnav").getByRole("button", { name: "עוד" }).click();
    await page.getByRole("menu").getByRole("button", { name: /הבית והגדרות/ }).click();
    await page.getByRole("button", { name: "כהה", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-dark", "1");
    await page.getByRole("button", { name: "בהיר", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-dark", "0");
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
  });
});
