// Automatic capture setup (next-features.md §2), 390px, live Supabase + synthetic fixture:
// create the code (shown once) → a wallet capture with it (svc_capture, as the function
// would call it) → shows in "מה נקלט ומתי" → a new code stops the old one.
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadEnv } from "../../scripts/lib/env.mjs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
const env = loadEnv();
const admin = () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const capture = (token: string, amount: number, merchant: string) => admin().rpc("svc_capture", {
  p_token: token, p_amount: amount, p_merchant: merchant, p_card: "", p_kind: "wallet", p_category: null,
  p_category_known: false, p_note: "", p_date: today,
});

test.describe("capture setup (live Supabase, synthetic data)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("code shown once → capture → log → rotation", async ({ page }) => {
    await page.addInitScript((s) => { localStorage.setItem("hb2-auth", s as string); localStorage.setItem("hb2-onboarded", "1"); }, JSON.stringify(fixture()!.member));
    await page.goto("./#/home");
    const card = page.locator("#captureSetup");
    await expect(card.getByRole("heading", { name: "קליטה אוטומטית באייפון" })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("שלב אחר שלב: Apple Pay")).toBeVisible();
    await card.getByRole("button", { name: "יצירת קוד" }).click();
    await expect(card.getByText("הקוד מוצג רק עכשיו.")).toBeVisible();
    const token1 = (await card.locator(".copyrow code").first().innerText()).trim();
    expect(token1).toMatch(/^hbc_[0-9a-f]{64}$/);
    await expect(card.locator("details").first()).toHaveAttribute("open", "");
    await expect(card).toContainText("/functions/v1/capture");
    await card.getByRole("button", { name: "סיימתי, להסתיר" }).click();
    await expect(card.locator("code", { hasText: token1 })).toHaveCount(0); // never shown again

    const merchant = `קפה בדיקה ${Date.now().toString(36)}`;
    const r = await capture(token1, 18.5, merchant);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ ok: true, duplicate: false, status: "review" });

    await page.locator(".bnav").getByRole("button", { name: "עוד" }).click();
    await page.getByRole("menu").getByRole("button", { name: "מה נקלט ומתי" }).click();
    const row = page.locator(".fxrow", { hasText: merchant });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Apple Pay");
    await expect(row.locator(".chip")).toHaveText("לאישור");
    if (process.env.SHOTS === "after") await page.screenshot({ path: "docs/features/2-capture/after/log.png", fullPage: true, animations: "disabled" });

    await page.goto("./#/home");
    await page.reload();
    await expect(card.getByRole("button", { name: /קוד חדש/ })).toBeVisible({ timeout: 20_000 });
    if (process.env.SHOTS === "after") await page.screenshot({ path: "docs/features/2-capture/after/home-capture.png", fullPage: true, animations: "disabled" });
    await card.getByRole("button", { name: /קוד חדש/ }).click();
    await expect(card.getByText("הקוד מוצג רק עכשיו.")).toBeVisible();
    expect((await capture(token1, 7, "אחרי החלפה")).data).toEqual({ ok: false, reason: "bad_token" });
    await card.getByRole("button", { name: "סיימתי, להסתיר" }).click();
    await card.getByRole("button", { name: "ביטול הקוד" }).click();
    await expect(page.getByText("הקוד בוטל.")).toBeVisible();
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
    // leave the shared fixture as found: the smoke test counts exactly one item waiting for approval
    await admin().from("transactions").delete().eq("household_id", fixture()!.householdId).eq("source", "wallet");
  });
});
