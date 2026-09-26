// iPhone-sized smoke test: every main screen renders in Hebrew RTL with no
// horizontal scrolling; a member can approve a receipt and edit the shared
// shopping list; an owner is stopped at the 2FA screen until aal2.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, "page must not scroll sideways at 390px").toBeLessThanOrEqual(cw);
}

async function signedIn(page: Page, session: unknown) {
  await page.addInitScript((s) => {
    localStorage.setItem("hb2-auth", s as string);
    localStorage.setItem("hb2-onboarded", "1");
  }, JSON.stringify(session));
}

test.describe("signed out", () => {
  test("sign-in screen: Hebrew RTL, e-mail field, no sideways scroll", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "הכסף של הבית" })).toBeVisible();
    await expect(page.getByLabel("כתובת מייל")).toBeVisible();
    await noHorizontalScroll(page);
  });

  test("install instructions for iPhone and Android", async ({ page }) => {
    await page.goto("./#/install");
    await expect(page.getByRole("heading", { name: "התקנה למסך הבית" })).toBeVisible();
    await expect(page.getByText("הוספה למסך הבית").first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe("member (live Supabase, synthetic data)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("overview, receipts to approve, tabs, shopping list", async ({ page }) => {
    const f = fixture()!;
    await signedIn(page, f.member);
    await page.goto("./#/overview");
    await expect(page.getByText("קבלה אחת מחכה לאישור.")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".hero .big")).toContainText("₪");
    await noHorizontalScroll(page);

    // approve the parsed receipt
    await page.getByRole("button", { name: "לאישור" }).click();
    await expect(page.getByRole("heading", { name: "קבלה אחת מחכה לאישור" })).toBeVisible();
    await page.getByRole("button", { name: "אישור", exact: true }).click();
    await expect(page.getByRole("heading", { name: "קבלה אחת מחכה לאישור" })).toHaveCount(0);
    await noHorizontalScroll(page);

    // add screen
    await page.locator(".bnav").getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByText("צילום קבלה")).toBeVisible();
    await expect(page.getByRole("heading", { name: "הוספה ידנית" })).toBeVisible();
    await noHorizontalScroll(page);

    // shared shopping list
    await page.locator(".bnav").getByRole("button", { name: "קניות" }).click();
    await page.getByLabel("פריט חדש").fill("עגבניות, מלפפונים");
    await page.getByRole("main").getByRole("button", { name: "הוספה", exact: true }).click();
    await expect(page.locator(".shop .nm", { hasText: "עגבניות" })).toBeVisible();
    await expect(page.locator(".shop .nm", { hasText: "מלפפונים" })).toBeVisible();
    await noHorizontalScroll(page);

    // settings
    await page.locator(".bnav").getByRole("button", { name: "עוד" }).click();
    await page.getByRole("menu").getByRole("button", { name: /הבית והגדרות/ }).click();
    await expect(page.getByRole("heading", { name: "מי בבית" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "אבטחה ואימות דו-שלבי" })).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe("owner and two-factor", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("an owner on a new device (aal1) must enter the authenticator code first", async ({ page }) => {
    const f = fixture()!;
    await signedIn(page, f.ownerAal1);
    await page.goto("./#/overview");
    await expect(page.getByRole("heading", { name: "קוד מאפליקציית האימות" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".hero")).toHaveCount(0); // no money data before the second factor
    await expect(page.getByRole("button", { name: "אין לי גישה לאפליקציה" })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test("owner at aal2 sees invites; the invite link is created", async ({ page }) => {
    const f = fixture()!;
    await signedIn(page, f.owner);
    await page.goto("./#/home");
    await expect(page.getByRole("heading", { name: "הזמנת בן בית" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "יצירת קישור הזמנה" }).click();
    await expect(page.locator(".secret")).toContainText("#/join/");
    await noHorizontalScroll(page);
  });
});
