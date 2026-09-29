// Regression tests for bugs.md, live Supabase with the synthetic fixture:
//  1. (2026-09-27) invite page after "already used": "למסך הכניסה" must lead to the sign-in screen
//  2. (2026-09-27) admin screen: "חזרה לאפליקציה" must show the app, not stay on admin
//  3. (2026-09-30) a transaction with an implausible AI-read date shows a "לבדוק תאריך" chip and its
//     date is editable by hand; the floating camera button no longer covers the last row's ✕
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

  test("date_uncertain: the 'לבדוק תאריך' chip shows, the date is editable, and the fab no longer hides the last row's ✕", async ({ page }) => {
    const f = fixture()!;
    const a = admin();
    // date_uncertain is set directly (not derived from apply_statement/svc_complete_receipt_job — those are
    // covered by the RLS suite with mutation testing); this only proves the UI surfaces and clears the flag.
    // The date itself stays in the CURRENT month so the row needs no month navigation to be visible — it is
    // exactly the kind of wrong-but-plausible-looking day a bad AI read produces (bugs.md's actual case was
    // 2025-06 instead of 2026-09; the day-of-month here is what would have been asked for).
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const merchant = `בדיקת תאריך ${Date.now().toString(36)}`;   // unique per run: never collides with the seeded rows
    const badDate = `${thisMonth}-03`;
    const ins = await a.from("transactions").insert({
      household_id: f.householdId, date: badDate, month: thisMonth, merchant, amount: 42,
      category: "שונות", source: "manual", status: "saved", created_by: f.userIds[0], person_id: null,
      date_uncertain: true,
    }).select("id").single();
    expect(ins.error).toBeNull();
    const txId = ins.data!.id as string;
    try {
      await page.addInitScript((s) => {
        localStorage.setItem("hb2-auth", s as string);
        localStorage.setItem("hb2-onboarded", "1");
      }, JSON.stringify(f.member));
      await page.goto("./#/tx");
      await expect(page.getByRole("heading", { name: "תנועות החודש" })).toBeVisible({ timeout: 20_000 });
      const row = page.locator(".tx", { hasText: merchant });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.locator(".chip.warn", { hasText: "לבדוק תאריך" })).toBeVisible();

      // the floating camera button must not overlap the last transaction row's delete button (visual bug #4)
      const fab = await page.locator(".fab").boundingBox();
      const lastX = await page.locator(".tx button.ghost", { hasText: "✕" }).last().boundingBox();
      expect(fab).toBeTruthy();
      expect(lastX).toBeTruthy();
      const overlaps = fab!.y < lastX!.y + lastX!.height && fab!.y + fab!.height > lastX!.y
        && fab!.x < lastX!.x + lastX!.width && fab!.x + fab!.width > lastX!.x;
      expect(overlaps, "the fab must not cover the last row's ✕ button").toBe(false);
      await page.screenshot({ path: "scratch/date-fix-list-light.png" });

      // dark mode: same checks, just a visual look (manual review — see scratch/, gitignored)
      await page.locator(".bnav").getByRole("button", { name: "עוד" }).click();
      await page.getByRole("menu").getByRole("button", { name: /הבית והגדרות/ }).click();
      await page.getByRole("button", { name: "כהה", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-dark", "1");
      await page.goto("./#/tx");
      await expect(row.locator(".chip.warn")).toBeVisible();
      await page.screenshot({ path: "scratch/date-fix-list-dark.png" });
      await page.locator(".bnav").getByRole("button", { name: "עוד" }).click();
      await page.getByRole("menu").getByRole("button", { name: /הבית והגדרות/ }).click();
      await page.getByRole("button", { name: "בהיר", exact: true }).click();
      await page.goto("./#/tx");

      // edit: the date field exists, is pre-filled with the (kept, uncorrected) AI date, and saving a fix clears the chip
      await row.locator(".m").click();
      const form = page.locator("form.txedit");
      await expect(form).toBeVisible();
      const dateInput = form.locator("#eDate");
      await expect(dateInput).toHaveValue(badDate);
      await expect(form.getByText("התאריך הזה התקבל אוטומטית")).toBeVisible();
      await page.screenshot({ path: "scratch/date-fix-edit-light.png" });
      const fixedDate = `${thisMonth}-20`;
      await dateInput.fill(fixedDate);
      await form.getByRole("button", { name: "שמירה" }).click();
      await expect(page.locator(".flash")).toContainText("נשמר");
      await expect(page.locator(".tx", { hasText: merchant }).locator(".chip.warn")).toHaveCount(0);
      expect((await a.from("transactions").select("date, date_uncertain").eq("id", txId).single()).data)
        .toEqual({ date: fixedDate, date_uncertain: false });
    } finally {
      await a.from("transactions").delete().eq("id", txId);
    }
  });
});
