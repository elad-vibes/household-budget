// Phase 2 RLS + triggers: budgets (80/100% alerts), goals, annual expenses,
// receipt line items (price history), push subscriptions, scheduled notifications.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";
import { NAMES } from "../fixtures/synthetic.ts";

let db: TestDb;
const C = "00000000-0000-4000-8000-0000000000cd";

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`
    delete from public.household_members where household_id = '${H.B}';
    insert into public.households (id, name) values ('${C}', '${NAMES.hhB} 2');
    insert into public.household_members values ('${C}', '${U.ownerB}', 'owner');
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), '${U.memberA}', 't', 'totp', 'verified', now(), now());`);
});
afterAll(async () => { await db?.close(); });

describe("budgets and alerts", () => {
  it("members write, viewers can't, other households can't see or write, aal1 with a factor is blocked", async () => {
    await db.as(as.memberA2, `insert into public.budgets (household_id, category, amount) values ($1, 'אוכל בחוץ ומשלוחים', 100)`, [H.A]);
    expect(await db.fails(as.viewerA, `insert into public.budgets (household_id, category, amount) values ($1, 'ביגוד והנעלה', 50)`, [H.A])).toMatch(/row-level security/);
    expect((await db.as(as.ownerB, `select * from public.budgets`)).rows).toHaveLength(0);
    expect(await db.fails(as.ownerB, `insert into public.budgets (household_id, category, amount) values ($1, 'x', 1)`, [H.A])).toMatch(/row-level security/);
    expect((await db.as(as.memberA, `select * from public.budgets`)).rows).toHaveLength(0);
  });

  it("80% and 100% fire once each and enqueue notifications", async () => {
    const ins = (amt: number) => db.as(as.memberA2,
      `insert into public.transactions (household_id, date, month, merchant, amount, category) values ($1, '2026-09-10', '2026-09', 'מסעדה', $2, 'אוכל בחוץ ומשלוחים')`, [H.A, amt]);
    await ins(85);
    let alerts = await db.sql(`select level from public.budget_alerts where household_id = $1 order by level`, [H.A]);
    expect(alerts.map((a) => a.level)).toEqual([80]);
    await ins(20);
    await ins(5);
    alerts = await db.sql(`select level from public.budget_alerts where household_id = $1 order by level`, [H.A]);
    expect(alerts.map((a) => a.level)).toEqual([80, 100]);
    const q = await db.sql(`select count(*)::int n from public.notification_queue where household_id = $1 and kind = 'budget'`, [H.A]);
    expect(q[0].n).toBe(2 * 3); // two alerts × three members of household A
    expect(await db.fails(as.ownerA, `select * from public.notification_queue`)).toMatch(/permission denied/);
  });
});

describe("goals, annual expenses, dismissals", () => {
  it("goal deposits stay inside the household and can't forge the author", async () => {
    const g = (await db.as(as.memberA2, `insert into public.savings_goals (household_id, name, target) values ($1, 'חופשה', 6000) returning id`, [H.A])).rows[0].id;
    await db.as(as.memberA2, `insert into public.goal_deposits (household_id, goal_id, amount) values ($1, $2, 500)`, [H.A, g]);
    expect(await db.fails(as.ownerB, `insert into public.goal_deposits (household_id, goal_id, amount) values ($1, $2, 1)`, [C, g])).toMatch(/foreign key|row-level/);
    expect(await db.fails(as.memberA2, `insert into public.goal_deposits (household_id, goal_id, amount, created_by) values ($1, $2, 1, $3)`, [H.A, g, U.ownerA])).toMatch(/row-level security/);
    expect((await db.as(as.ownerB, `select * from public.goal_deposits`)).rows).toHaveLength(0);
  });

  it("annual expenses and dismissals: writers only, private to the household", async () => {
    await db.as(as.ownerA, `insert into public.annual_expenses (household_id, name, amount, due_month, due_day) values ($1, 'ביטוח רכב', 2400, 3, 1)`, [H.A]);
    expect(await db.fails(as.viewerA, `insert into public.annual_expenses (household_id, name, amount, due_month) values ($1, 'x', 1, 1)`, [H.A])).toMatch(/row-level security/);
    await db.as(as.memberA2, `insert into public.suggestion_dismissals (household_id, key) values ($1, 'fixed:x')`, [H.A]);
    expect((await db.as(as.ownerB, `select * from public.annual_expenses`)).rows).toHaveLength(0);
    expect((await db.as(as.ownerB, `select * from public.suggestion_dismissals`)).rows).toHaveLength(0);
  });
});

describe("receipt line items (price history) and 'ready' notifications", () => {
  it("parsed items are stored for the household only; writers get 'ready to approve'", async () => {
    const res = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 1, 0.002) as r`, [H.A, U.memberA])).rows[0].r;
    const job = (await db.as(as.service,
      `select public.svc_record_receipt_job($1, $2, 'msgbatch_items', 'claude-haiku-4-5', '[{"client_id":"ci1"}]'::jsonb, $3) as id`,
      [H.A, U.memberA, res.reservation_id])).rows[0].id;
    const results = JSON.stringify([{ client_id: "ci1", ok: true, receipt: { merchant: "סופר השכונה", date: "2026-09-20", total: 20.7,
      category: "סופר ומכולת", note: "", items: [{ name: "חלב 3% (1 ליטר)", qty: 3, unit_price: 6.9, total: 20.7 }] } }]);
    await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 100, 10, 0.0001)`, [job, results]);
    const items = (await db.as(as.memberA2, `select name, norm_name, unit_price, store from public.receipt_items`)).rows;
    expect(items).toEqual([{ name: "חלב 3% (1 ליטר)", norm_name: "חלב 3% 1 ליטר", unit_price: "6.90", store: "סופר השכונה" }]);
    expect((await db.as(as.ownerB, `select * from public.receipt_items`)).rows).toHaveLength(0);
    const ready = await db.sql(`select user_id from public.notification_queue where kind = 'receipts' and dedupe_key = $1`, [job]);
    expect(ready.map((r) => r.user_id).sort()).toEqual([U.ownerA, U.memberA].sort()); // viewers can't approve
  });
});

describe("push subscriptions and preferences", () => {
  const sub = (u: string) => [`https://push.example.test/${u}`, "B".repeat(87), "a".repeat(22)];
  it("personal rows only; a user with a factor needs aal2 to subscribe", async () => {
    await db.as(as.memberA2, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, sub("m"));
    expect(await db.fails(as.memberA, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, sub("m1"))).toMatch(/row-level security/);
    expect(await db.fails(as.memberA2, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)`, [U.ownerA, ...sub("x")])).toMatch(/row-level security/);
    expect((await db.as(as.ownerA, `select * from public.push_subscriptions`)).rows).toHaveLength(0);
    await db.as(as.viewerA, `insert into public.notification_prefs (quiet_start, quiet_end) values (21, 8)`);
    expect(await db.fails(as.viewerA, `insert into public.notification_prefs (user_id) values ($1)`, [U.ownerA])).toMatch(/row-level security/);
    expect((await db.as(as.ownerA, `select * from public.notification_prefs`)).rows).toHaveLength(0);
  });

  it("scheduled: bill 3 days ahead + weekly summary; quiet hours wait; each is sent once", async () => {
    const sunday10 = "2026-09-27T07:00:00Z";       // Sunday 10:00 Israel time
    await db.sql(`insert into public.fixed_expenses (household_id, name, amount, keyword, category, due_day) values ($1, 'ארנונה', 610, 'עיריית', 'חשבונות בית', 28)`, [H.A]);
    await db.sql(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example.test/o', $2, $3)`, [U.ownerA, "B".repeat(87), "a".repeat(22)]);
    const due = (await db.as(as.service, `select * from public.svc_due_notifications($1)`, [sunday10])).rows;
    const mine = due.filter((d) => d.endpoint === "https://push.example.test/o");
    expect(mine.some((d) => d.title === "חיוב קרוב: ארנונה")).toBe(true);
    expect(mine.some((d) => d.title === "סיכום שבועי")).toBe(true);
    const night = (await db.as(as.service, `select * from public.svc_due_notifications($1)`, ["2026-09-27T20:30:00Z"])).rows; // 23:30
    expect(night.filter((d) => d.endpoint === "https://push.example.test/o")).toHaveLength(0);
    await db.as(as.service, `select public.svc_mark_sent($1::uuid[], '{}'::uuid[], '{}'::uuid[])`, [mine.map((d) => d.queue_id)]);
    const again = (await db.as(as.service, `select * from public.svc_due_notifications($1)`, [sunday10])).rows;
    expect(again.filter((d) => d.endpoint === "https://push.example.test/o")).toHaveLength(0);
  });

  it("notification service functions are closed to app users", async () => {
    expect(await db.fails(as.ownerA, `select * from public.svc_due_notifications()`)).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `select public.enqueue_household($1, 'test', 'x', 'y', 'z', 'k')`, [H.A])).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `select * from public.svc_user_subscriptions($1)`, [U.ownerA])).toMatch(/permission denied/);
  });
});
