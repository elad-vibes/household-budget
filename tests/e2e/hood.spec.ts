// §6 "השכונה שלנו": the card is on the overview, a building opens that category's transactions.
// SHOTS=before|after SHOTS_DIR=… also saves the card alone (the full-page shot has the fixed nav on top of it).
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
test.skip(() => !fixture(), "needs .env.local (local runs only)");
test.use({ deviceScaleFactor: 2 });

for (const dark of [false, true]) {
  test(`neighborhood card ${dark ? "dark" : "light"}`, async ({ page }) => {
    if (dark) await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.member));
    await page.goto("./#/overview");
    const card = page.locator(".hoodcard");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator("svg.hood")).toHaveAttribute("role", "img");
    expect(await card.locator(".hb-b").count()).toBeGreaterThan(0);
    // no sideways scroll at 390px
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.SHOTS === "after") {
      const dir = `${process.env.SHOTS_DIR ?? "docs/features/6-neighborhood"}/after`;
      mkdirSync(dir, { recursive: true });
      await page.addStyleTag({ content: ".bnav,.fab{display:none!important}" }); // fixed bars would cover the card in the crop
      await page.waitForTimeout(900);
      await card.screenshot({ path: `${dir}/hood-card${dark ? "-dark" : ""}.png`, animations: "disabled" });
    }
    if (!dark) {
      await card.locator(".hb-b").first().dispatchEvent("click");
      await expect(page).toHaveURL(/#\/tx/);
    }
  });
}
