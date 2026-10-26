// Design-pass screenshots (390px) of every main screen, on the synthetic live fixture.
// Runs only when SHOTS=before|after:  SHOTS=before npx playwright test screens
// Output: docs/design-pass/<before|after>/<screen>.png (synthetic data only — DECISIONS #25).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const SHOTS = process.env.SHOTS;
const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
// SHOTS_DIR=docs/features/<n>-<name> keeps per-feature before/after apart from the design pass
const dir = `${process.env.SHOTS_DIR ?? "docs/design-pass"}/${SHOTS}`;

test.use({ deviceScaleFactor: 2 });
test.skip(() => SHOTS !== "before" && SHOTS !== "after", "set SHOTS=before|after");

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200); // count-up / transitions settle
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: "disabled" });
}

async function signedIn(page: Page, session: unknown) {
  await page.addInitScript((s) => {
    localStorage.setItem("hb2-auth", s as string);
    localStorage.setItem("hb2-onboarded", "1");
  }, JSON.stringify(session));
}

test("signin", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByLabel("כתובת מייל")).toBeVisible();
  await shot(page, "signin");
});

test.describe("signed in", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  for (const tab of ["overview", "tx", "add", "fixed", "plan", "shop", "home"]) {
    test(tab, async ({ page }) => {
      await signedIn(page, fixture()!.member);
      await page.goto(`./#/${tab}`);
      await expect(page.locator(".bnav")).toBeVisible({ timeout: 20_000 });
      await shot(page, tab);
    });
  }

  for (const tab of ["overview", "tx", "plan"]) {
    test(`${tab}-dark`, async ({ page }) => {
      test.skip(SHOTS !== "after", "dark mode is new in the design pass");
      await page.emulateMedia({ colorScheme: "dark" });
      await signedIn(page, fixture()!.member);
      await page.goto(`./#/${tab}`);
      await expect(page.locator(".bnav")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("html")).toHaveAttribute("data-dark", "1");
      await shot(page, `${tab}-dark`);
    });
  }

  test("home-owner", async ({ page }) => {
    await signedIn(page, fixture()!.owner);
    await page.goto("./#/home");
    await expect(page.getByRole("heading", { name: "חברי משק הבית" })).toBeVisible({ timeout: 20_000 });
    await shot(page, "home-owner");
  });
});
