// Regression tests for bugs.md (2026-09-27), live Supabase with the synthetic fixture:
//  1. invite page after "already used": "למסך הכניסה" must lead to the sign-in screen
//  2. admin screen: "חזרה לאפליקציה" must show the app, not stay on admin
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnv } from "../../scripts/lib/env.mjs";
import type { Fixture } from "./live.ts";

const fixture = (): Fixture | null => JSON.parse(readFileSync("test-results/e2e-fixture.json", "utf8"));
const env = loadEnv();
const admin = () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.describe("bugs.md regressions (live Supabase, synthetic data)", () => {
  test.skip(() => !fixture(), "needs .env.local (local runs only)");

  test("used invite: 'למסך הכניסה' goes to the sign-in screen (and stays there after reload)", async ({ page }) => {
    const f = fixture()!;
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    const ins = await admin().from("invites").insert({
      household_id: f.householdId, token_hash: hash, role: "member", used_at: new Date().toISOString(), used_by: f.userIds[0],
    });
    expect(ins.error).toBeNull();

    await page.goto(`./#/join/${token}`);
    await expect(page.getByRole("heading", { name: "הזמנה" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".banner.err")).toBeVisible();
    await page.getByRole("button", { name: "למסך הכניסה" }).click();
    await expect(page.getByRole("heading", { name: "הכסף של הבית" })).toBeVisible();
    await expect(page.getByLabel("כתובת מייל")).toBeVisible();
    await expect(page.getByRole("heading", { name: "הזמנה", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hb2-join"))).toBeNull();
    await page.reload();
    await expect(page.getByLabel("כתובת מייל")).toBeVisible();
    await expect(page.getByRole("heading", { name: "הזמנה", exact: true })).toHaveCount(0);
  });

  test("admin screen: 'חזרה לאפליקציה' returns to the app", async ({ page }) => {
    const f = fixture()!;
    const ownerId = f.userIds[1];
    const a = admin();
    expect((await a.from("app_admins").insert({ user_id: ownerId })).error).toBeNull();
    try {
      await page.addInitScript((s) => {
        localStorage.setItem("hb2-auth", s as string);
        localStorage.setItem("hb2-onboarded", "1");
      }, JSON.stringify(f.owner));
      await page.goto("./#/admin");
      await expect(page.getByRole("heading", { name: "ניהול מערכת" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "חזרה לאפליקציה" }).click();
      await expect(page.locator(".bnav")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "ניהול מערכת" })).toHaveCount(0);
      expect(page.url()).toContain("#/home");
      await expect(page.getByRole("heading", { name: "משק הבית", exact: true })).toBeVisible();
    } finally {
      await a.from("app_admins").delete().eq("user_id", ownerId);
    }
  });
});
