// אזור תאילנד (0016, DECISIONS #42), 390px. The live database does not have 0016 until Elad applies it, so the
// household's region is injected into the REST answers (household_settings.region = "TH", Thai default payment
// methods) and fx-rates is intercepted — everything else is the real app on the synthetic fixture. What it proves:
// ฿ everywhere, Thai payment methods / banks / categories, no "איפה הכי זול?", the trip card quoted in baht.
// SHOTS=after SHOTS_DIR=docs/features/8-thailand also saves 390px screenshots (light + dark).
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
test.skip(() => !fixture(), "needs .env.local (local runs only)");
test.use({ deviceScaleFactor: 2 });

const today = new Date().toISOString().slice(0, 10);
const RATES = { ok: true, fetched: "cached", stale: false, lastSuccess: new Date().toISOString(), base: "THB",
  official: { ILS: { rate: 10.9769, date: today, source: "ecb" }, USD: { rate: 33.79, date: today, source: "cross" } }, manual: {} };
const TH_METHODS = [
  ["cash", "מזומן", "", 1], ["e_wallet", "PromptPay / Thai QR", "PromptPay", 20], ["e_wallet", "TrueMoney Wallet", "TrueMoney", 21],
  ["e_wallet", "Rabbit LINE Pay", "Rabbit LINE Pay", 22], ["bank_transfer", "העברה בנקאית", "", 91], ["other", "אחר", "", 99],
].map(([type, label, issuer, sort], i) => ({ id: `00000000-0000-4000-8000-0000000000${10 + i}`, household_id: "x", type, label, issuer, last4: null, person_id: null, active: true, sort }));

const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
async function patched(route: Route, patch: (rows: any[]) => any[]) {
  const res = await route.fetch();
  const body = await res.json();
  const asObject = !Array.isArray(body);
  const out = patch(asObject ? [body] : body);
  await route.fulfill({ response: res, body: JSON.stringify(asObject ? out[0] : out) });
}

async function thailand(page: Page) {
  await page.route("**/rest/v1/household_settings*", (r) => r.request().method() === "GET" ? patched(r, (rows) => rows.map((x) => ({ ...x, region: "TH", trip_currency: "ILS" }))) : r.continue());
  await page.route("**/rest/v1/payment_methods*", (r) => r.request().method() === "GET" ? patched(r, () => TH_METHODS) : r.continue());
  await page.route("**/functions/v1/fx-rates", (r) => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } })
    : r.fulfill({ status: 200, headers: cors, body: JSON.stringify(RATES) }));
  await page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.owner));
}
const noSideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
async function shot(page: Page, name: string) {
  if (process.env.SHOTS !== "after") return;
  const dir = `${process.env.SHOTS_DIR ?? "docs/features/8-thailand"}/after`;
  mkdirSync(dir, { recursive: true });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: "disabled" });
}

for (const dark of [false, true]) {
  const sfx = dark ? "-dark" : "";
  test.describe(`Thailand household ${dark ? "dark" : "light"}`, () => {
    test.beforeEach(async ({ page }) => { if (dark) await page.emulateMedia({ colorScheme: "dark" }); await thailand(page); });

    test("overview and transactions are in baht", async ({ page }) => {
      await page.goto("./#/overview");
      await expect(page.locator(".bnav")).toBeVisible({ timeout: 20_000 });
      const text = await page.locator("body").innerText();
      expect(text).toContain("฿");
      expect(text).not.toContain("₪");
      await noSideScroll(page);
      await shot(page, `overview${sfx}`);
    });

    test("home: region card, Thai payment methods and banks, trip card in baht", async ({ page }) => {
      await page.goto("./#/home");
      const region = page.locator("#regionCard");
      await expect(region.getByRole("heading", { name: "אזור" })).toBeVisible({ timeout: 20_000 });
      await expect(region.locator("select")).toHaveValue("TH");
      await expect(region.locator("select")).toBeDisabled();                       // the fixture already has expenses
      await expect(region).toContainText("אי אפשר להחליף אזור");
      // payment methods: PromptPay / TrueMoney / Rabbit LINE Pay, no bit / PayBox, Thai banks in the issuer suggestions
      await expect(page.getByText("PromptPay / Thai QR").first()).toBeVisible();
      await expect(page.getByText("TrueMoney Wallet").first()).toBeVisible();
      await expect(page.getByText("Rabbit LINE Pay").first()).toBeVisible();
      await expect(page.getByText("ביט / פייבוקס")).toHaveCount(0);
      const types = await page.locator("#pmType option").allInnerTexts();
      expect(types).toContain("ארנק דיגיטלי / QR");
      expect(types).not.toContain("ביט / פייבוקס");
      const banks = await page.locator("#pmIssuers option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      for (const b of ["Kasikorn (KBank)", "SCB", "Bangkok Bank", "Krungthai", "Krungsri", "TMBThanachart (ttb)", "UOB", "CIMB Thai", "Government Savings Bank"]) expect(banks).toContain(b);
      expect(banks).not.toContain("ישראכרט");
      // trip card: the foreign currency is never the baht, rates are quoted in baht
      const trip = page.locator("#tripCard");
      await expect(trip.locator("select option[value=THB]")).toHaveCount(0);
      await expect(trip.locator("select option[value=ILS]")).toHaveCount(1);
      await trip.getByLabel("מצב טיול פעיל").check();
      await expect(trip).toContainText("1 ₪ = ฿10.98", { timeout: 20_000 });
      await trip.getByLabel("מצב טיול פעיל").uncheck();
      await noSideScroll(page);
      await shot(page, `home${sfx}`);
    });

    test("add: Thai categories and payment chips", async ({ page }) => {
      await page.goto("./#/add");
      await expect(page.locator("#mCat")).toBeVisible({ timeout: 20_000 });
      const cats = await page.locator("#mCat option").allInnerTexts();
      expect(cats).toContain("ויזה ואישורי שהייה");
      expect(cats).toContain("מרכזים מסחריים");
      expect(cats).toContain("סופר ומכולת");                    // nothing Israeli was removed
      await expect(page.getByText("TrueMoney Wallet").first()).toBeVisible();
      await noSideScroll(page);
      await shot(page, `add${sfx}`);
    });

    test("shopping list: no 'איפה הכי זול?' for Thailand, an explanation instead", async ({ page }) => {
      await page.goto("./#/shop");
      await expect(page.getByRole("heading", { name: "רשימת קניות" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "איפה הכי זול?" })).toHaveCount(0);
      await expect(page.getByText("לא זמינה באזור הזה")).toBeVisible();
      await noSideScroll(page);
      await shot(page, `shop${sfx}`);
    });
  });
}
