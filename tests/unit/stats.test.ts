// Admin dashboard (scripts/stats): allow-list clean-up, health checks, page rendering, SCRAM verifier.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanSnapshot, cronEveryMinutes, deployFromRuns, healthChecks } from "../../scripts/stats/snapshot.mjs";
import { renderPage } from "../../scripts/stats/render.mjs";
import { scramVerifier } from "../../scripts/lib/scram.mjs";
import { NAMES } from "../fixtures/synthetic.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

function raw(over: Record<string, unknown> = {}) {
  return {
    month: "2026-10", generated_at: minsAgo(2),
    households: { total: 3, active_30d: 2 }, users: { total: 6, active_7d: 4, active_30d: 5 },
    ai: {
      month_usd: 1.2345678, cap_usd: 30,
      by_household: [
        { n: 1, usd: 0.5, quota_usd: 3, images: 20, quota_images: 150, statements: 2, quota_statements: 10, analyses: 1, quota_analyses: 8 },
        { n: 2, usd: 0.7345, quota_usd: 3, images: 40, quota_images: 150, statements: 1, quota_statements: 10, analyses: 0, quota_analyses: 8 },
      ],
      last_months: [{ month: "2026-09", usd: 2.5 }, { month: "2026-10", usd: 1.2345 }],
    },
    receipts: { parsed: 50, unreadable: 2, failed: 0, waiting: 3, open_batches: 1, oldest_open_at: minsAgo(60), last_checked_at: minsAgo(10) },
    statements: { ok: 3, failed: 0 }, analyses: { ok: 1, failed: 0 },
    cron: [
      { job: "hb-poll-batches", schedule: "*/30 * * * *", active: true, last_run_at: minsAgo(12), last_status: "succeeded", runs_24h: 48, failed_24h: 0 },
      { job: "hb-notify", schedule: "5,35 * * * *", active: true, last_run_at: minsAgo(20), last_status: "succeeded", runs_24h: 48, failed_24h: 0 },
      { job: "hb-cleanup", schedule: "17 3 * * *", active: true, last_run_at: minsAgo(600), last_status: "succeeded", runs_24h: 1, failed_24h: 0 },
    ],
    ...over,
  };
}
const deploy = { last_success_at: minsAgo(180), latest_at: minsAgo(180), latest_state: "success", sha: "448fbef" };

describe("cleanSnapshot", () => {
  it("keeps only allow-listed fields and normalizes numbers", () => {
    const r: any = raw();
    r.households.names = [NAMES.hhA];
    r.ai.by_household[0].name = NAMES.hhB;
    r.extra = { merchant: "שופרסל", email: "x@example.test" };
    r.cron.push({ job: "evil'job", schedule: "x", last_status: "pwned" });
    r.cron[0].schedule = "@daily";
    const s = cleanSnapshot(r, deploy);
    const text = JSON.stringify(s);
    for (const bad of [NAMES.hhA, NAMES.hhB, "שופרסל", "@", "evil"]) expect(text).not.toContain(bad);
    expect(s.cron).toHaveLength(3);
    expect(s.cron![0].schedule).toBe("");
    expect(s.ai.month_usd).toBe(1.2346);
    expect(s.deploy).toEqual(deploy);
  });

  it("drops bad months, dates, ids and states; cron null stays null", () => {
    const s = cleanSnapshot(raw({ month: "Oct", cron: null }), { last_success_at: "nope", latest_state: "weird", sha: "zz" });
    expect(s.month).toBeNull();
    expect(s.cron).toBeNull();
    expect(s.deploy).toEqual({ last_success_at: null, latest_at: null, latest_state: null, sha: null });
  });
});

describe("deployFromRuns / cronEveryMinutes", () => {
  it("summarizes GitHub workflow runs", () => {
    const latest = { workflow_runs: [{ status: "in_progress", conclusion: null, updated_at: minsAgo(1), head_sha: "a".repeat(40) }] };
    const ok = { workflow_runs: [{ status: "completed", conclusion: "success", updated_at: minsAgo(90), head_sha: "b".repeat(40) }] };
    expect(deployFromRuns(latest, ok)).toEqual({ last_success_at: minsAgo(90), latest_at: minsAgo(1), latest_state: "running", sha: "bbbbbbb" });
    expect(deployFromRuns({ workflow_runs: [] }, { workflow_runs: [] })).toBeNull();
  });

  it("reads the schedules we use", () => {
    expect(cronEveryMinutes("*/30 * * * *")).toBe(30);
    expect(cronEveryMinutes("5,35 * * * *")).toBe(30);
    expect(cronEveryMinutes("17 3 * * *")).toBe(1440);
    expect(cronEveryMinutes("0 9 * * 1")).toBeNull();
  });
});

describe("healthChecks", () => {
  it("all good → one ok line", () => {
    expect(healthChecks(cleanSnapshot(raw(), deploy), NOW)).toEqual([{ level: "ok", text: "הכול תקין" }]);
  });

  it("flags stale data, cost near/over quota, failed or late cron, old receipts, failed deploy — worst first", () => {
    const r: any = raw({ generated_at: minsAgo(45) });
    r.ai.month_usd = 25;
    r.ai.by_household[0].usd = 3.1;
    r.ai.by_household[1].usd = 2.5;
    r.cron[0].last_status = "failed";
    r.cron[1].last_run_at = minsAgo(120);
    r.cron[2].failed_24h = 1;
    r.receipts.oldest_open_at = minsAgo(27 * 60);
    r.statements.failed = 2;
    const checks = healthChecks(cleanSnapshot(r, { ...deploy, latest_state: "failure" }), NOW);
    const texts = checks.map((c) => `${c.level}:${c.text}`);
    expect(texts).toContain("bad:הנתונים לא התעדכנו מעל 20 דקות");
    expect(texts).toContain("warn:עלות AI החודש מעל 80% מהתקרה");
    expect(texts).toContain("bad:משפחה 1 הגיעה למכסת העלות");
    expect(texts).toContain("warn:משפחה 2 מעל 80% ממכסת העלות");
    expect(texts).toContain("bad:הריצה האחרונה של hb-poll-batches נכשלה");
    expect(texts).toContain("bad:hb-notify לא רצה בזמן");
    expect(texts).toContain("warn:hb-cleanup: 1 כשלים ב-24 שעות");
    expect(texts).toContain("bad:יש קבלות שממתינות לקריאה יותר מ-26 שעות");
    expect(texts).toContain("warn:2 דפי חשבון נכשלו החודש");
    expect(texts).toContain("bad:ההעלאה האחרונה לאתר נכשלה");
    const lastBad = checks.map((c) => c.level).lastIndexOf("bad");
    expect(checks.findIndex((c) => c.level === "warn")).toBeGreaterThan(lastBad);
  });

  it("collector error and missing cron access are shown", () => {
    const s = { ...cleanSnapshot(raw({ cron: null }), deploy), collector_error: "חיבור" };
    const texts = healthChecks(s, NOW).map((c) => c.text);
    expect(texts[0]).toContain("האיסוף האחרון נכשל");
    expect(texts).toContain("אין מידע על המשימות האוטומטיות");
  });
});

describe("renderPage", () => {
  const page = renderPage(cleanSnapshot(raw(), deploy), NOW);

  it("is a self-contained Hebrew RTL page with every section", () => {
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('dir="rtl"');
    expect(page).toContain('name="robots" content="noindex, nofollow"');
    for (const s of ["משפחות פעילות", "משתמשים פעילים", "עלות AI החודש", "העלאה אחרונה לאתר", "משפחה 1", "משפחה 2",
      "קבלות החודש", "דפי חשבון החודש", "משימות אוטומטיות", "קריאת קבלות שנשלחו", "448fbef", "הכול תקין"]) {
      expect(page).toContain(s);
    }
    expect(page).not.toMatch(/(src|href)="https?:/);   // no external requests
  });

  it("escapes values and labels a status with an icon + text, never color alone", () => {
    const s: any = cleanSnapshot(raw(), deploy);
    s.cron[0].job = "hb-<b>x";   // cleanSnapshot would drop it; render must still escape
    const p = renderPage(s, NOW);
    expect(p).toContain("hb-&lt;b&gt;x");
    expect(p).not.toContain("hb-<b>x");
    expect(page).toMatch(/class="chip ok"><b aria-hidden="true">✓<\/b>/);
  });

  it("times are shown in Thailand time", () => {
    expect(page).toContain("26.10 18:58");   // generated 11:58Z = 18:58 in Bangkok
  });
});

describe("scramVerifier", () => {
  it("matches RFC 7677's test vector (server signature for pencil / W22ZaJ0SNY7soEsUEjb6gQ==)", () => {
    const v = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"), 4096);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const serverKey = Buffer.from(v.split(":").pop()!, "base64");
    const authMessage = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,"
      + "s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    expect(createHmac("sha256", serverKey).update(authMessage).digest("base64")).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  });
});
