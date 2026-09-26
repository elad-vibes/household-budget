// Mobile-viewport E2E smoke test (iPhone-sized, 390×844) against the dev server.
// Uses the local Edge (ARM64 Windows) or Playwright's Chromium elsewhere.
// Signed-in tests need .env.local (live Supabase, synthetic fixture) — local only.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: "./tests/e2e/global.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173/household-budget/",
    channel: process.env.PW_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "he-IL",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --port 5173 --strictPort",
    url: "http://localhost:5173/household-budget/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
