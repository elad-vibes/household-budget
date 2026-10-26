// 0012_admin_stats.sql: the admin dashboard's snapshot — counts only, callable only by hb_stats.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";
import { NAMES } from "../fixtures/synthetic.ts";

let db: TestDb;
let snap: any;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`
    update auth.users set last_sign_in_at = now() - interval '40 days' where id = '${U.viewerA}';
    insert into auth.sessions (user_id, updated_at) values ('${U.memberA}', now() - interval '2 days');
    insert into public.usage_ledger (household_id, kind, units, usd, status, month) values
      ('${H.B}', 'statement', 1, 0.05, 'released', public.local_month()),
      ('${H.A}', 'analysis', 1, 0.02, 'final', public.local_month()),
      ('${H.A}', 'receipt', 1, 0.004, 'final', '2020-01');
    update public.receipt_jobs set items = '[{"client_id":"c1","status":"parsed"},{"client_id":"c2","status":"unreadable"}]'::jsonb
      where household_id = '${H.A}';
    update public.receipt_jobs set items = '[{"client_id":"c3","status":"submitted"}]'::jsonb
      where household_id = '${H.B}';
  `);
  snap = (await db.as(as.stats, `select public.stats_snapshot() as s`)).rows[0].s;
});
afterAll(async () => { await db?.close(); });

describe("admin stats snapshot (0012)", () => {
  it("counts households, users and recent activity", () => {
    expect(snap.households).toEqual({ total: 2, active_30d: 2 });
    // members only (the super-admin is not a member); viewerA last seen 40 days ago
    expect(snap.users).toEqual({ total: 4, active_7d: 3, active_30d: 3 });
  });

  it("AI cost this month per household (by ordinal) against the quota and the global cap", () => {
    expect(Number(snap.ai.month_usd)).toBeCloseTo(0.076, 4);
    expect(Number(snap.ai.cap_usd)).toBe(30);
    const [a, b] = snap.ai.by_household;
    expect(a).toMatchObject({ n: 1, images: 3, analyses: 1, statements: 0 });
    expect(Number(a.usd)).toBeCloseTo(0.026, 4);
    expect(Number(a.quota_usd)).toBe(3);
    expect(b).toMatchObject({ n: 2, images: 0, statements: 1 });
    expect(snap.ai.last_months).toHaveLength(6);
    expect(snap.ai.last_months[5].month).toBe(snap.month);
  });

  it("receipt and statement outcomes; cron is null where pg_cron doesn't exist", () => {
    expect(snap.receipts).toMatchObject({ parsed: 1, unreadable: 1, failed: 0, waiting: 1, open_batches: 2 });
    expect(snap.receipts.oldest_open_at).toBeTruthy();
    expect(snap.statements).toEqual({ ok: 1, failed: 1 });
    expect(snap.analyses).toEqual({ ok: 1, failed: 0 });
    expect(snap.cron).toBeNull();
  });

  it("never contains names, e-mails, merchants, purchase amounts or ids", () => {
    const text = JSON.stringify(snap);
    for (const name of Object.values(NAMES)) expect(text).not.toContain(name);
    expect(text).not.toContain("@");
    for (const merchant of ["שופרסל", "חברת החשמל", "רמי לוי", "הראל", "חלב"]) expect(text).not.toContain(merchant);
    // (only amounts with a decimal point — bare "420" could appear inside a timestamp's microseconds)
    for (const amount of ["312.4", "199.9", "420.0", "610.0"]) expect(text).not.toContain(amount);
    for (const id of [...Object.values(H), ...Object.values(U)]) expect(text).not.toContain(id);
  });

  it("only hb_stats may call it — not app users, not the super-admin, not anon or the service role", async () => {
    for (const actor of [as.memberA, as.ownerA, as.admin, as.anon, as.service]) {
      expect(await db.fails(actor, `select public.stats_snapshot()`)).toMatch(/permission denied/);
    }
  });

  it("hb_stats itself can't read any table or call other RPCs", async () => {
    for (const table of ["public.transactions", "public.households", "public.people", "public.usage_ledger",
      "public.receipt_jobs", "public.app_config", "auth.users", "auth.sessions"]) {
      expect(await db.fails(as.stats, `select * from ${table} limit 1`)).toMatch(/permission denied/);
    }
    expect(await db.fails(as.stats, `select * from public.admin_overview()`)).toMatch(/permission denied|not_admin/);
    expect(await db.fails(as.stats, `update public.app_config set value = '1'`)).toMatch(/permission denied/);
  });

  it("is SECURITY DEFINER with an empty search_path", async () => {
    const [p] = await db.sql(`select prosecdef, proconfig from pg_proc where proname = 'stats_snapshot'`);
    expect(p.prosecdef).toBe(true);
    expect(p.proconfig).toContain('search_path=""');
  });
});
