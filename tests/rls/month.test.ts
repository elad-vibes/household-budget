// Month boundaries in the database. The first two blocks pin the behavior BEFORE "budget
// month start" (feature 3) and stay unchanged; the last block covers 0013 (start day > 1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";
import { budgetMonth } from "../../src/domain/month.ts";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); await seed(db); });
afterAll(async () => { await db?.close(); });

const ins = (date: string, month: string, amount: number, category = "סופר ומכולת") =>
  db.as(as.memberA2, `insert into public.transactions (household_id, date, month, merchant, amount, category) values ($1, $2, $3, 'מכולת', $4, $5)`,
    [H.A, date, month, amount, category]);
const alerts = async () => (await db.sql(`select month, level from public.budget_alerts where household_id = $1 order by month, level`, [H.A]))
  .map((a) => `${a.month}:${a.level}`);

describe("budget alerts at the month boundary (stored month)", () => {
  it("the 31st and the 1st fill different months; an installment counts in its stored month", async () => {
    await db.as(as.memberA2, `insert into public.budgets (household_id, category, amount) values ($1, 'סופר ומכולת', 1000)`, [H.A]);
    await ins("2026-10-31", "2026-10", 800);
    expect(await alerts()).toEqual(["2026-10:80"]);
    await ins("2026-11-01", "2026-11", 300);
    expect(await alerts()).toEqual(["2026-10:80"]);
    await ins("2026-08-14", "2026-10", 250);   // bought in August, billed in October
    expect(await alerts()).toEqual(["2026-10:80", "2026-10:100"]);
  });
});

describe("weekly summary", () => {
  it("'מתחילת החודש' = the calendar month of the user's local time, by stored month", async () => {
    await db.sql(`delete from public.transactions where household_id = $1`, [H.A]);
    await ins("2026-09-30", "2026-09", 200);
    await ins("2026-10-01", "2026-10", 100);
    await ins("2026-08-14", "2026-10", 300);
    await db.sql(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example.test/m', $2, $3)`,
      [U.ownerA, "B".repeat(87), "a".repeat(22)]);
    const sunday10 = "2026-10-04T07:00:00Z";   // Sunday 10:00 in Israel
    const due = (await db.as(as.service, `select * from public.svc_due_notifications($1)`, [sunday10])).rows;
    const weekly = due.find((d) => d.endpoint === "https://push.example.test/m" && d.title === "סיכום שבועי");
    expect(weekly?.body).toBe("השבוע יצאו 300 ₪. מתחילת החודש: 400 ₪.");
  });
});

describe("budget month start (0013)", () => {
  it("SQL budget_month() = TS budgetMonth() for every day around the boundaries, starts 1/10/28, incl. moved rows", async () => {
    const days: string[] = [];
    for (const [from, to] of [["2025-12-20", "2026-01-12"], ["2026-02-20", "2026-03-12"], ["2028-02-20", "2028-03-02"]]) {
      for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    }
    const cases = days.flatMap((day) => [1, 10, 28].flatMap((st) => [[day, day.slice(0, 7), st], [day, "2026-05", st]] as [string, string, number][]));
    const rows = await db.sql(`select x.d::text as d, x.m, x.s, public.budget_month(x.d, x.m, x.s::smallint) as bm
      from jsonb_to_recordset($1::jsonb) as x(d date, m text, s int)`, [JSON.stringify(cases.map(([d, m, s]) => ({ d, m, s })))]);
    expect(rows).toHaveLength(cases.length);
    for (const r of rows) expect(`${r.d}|${r.m}|${r.s}|${r.bm}`).toBe(`${r.d}|${r.m}|${r.s}|${budgetMonth({ date: r.d, month: r.m }, r.s)}`);
  });

  it("members set the start day (1–28); viewers and other households can't", async () => {
    await db.as(as.memberA2, `update public.household_settings set month_start_day = 10 where household_id = $1`, [H.A]);
    expect((await db.sql(`select month_start_day from public.household_settings where household_id = $1`, [H.A]))[0].month_start_day).toBe(10);
    expect(await db.fails(as.memberA2, `update public.household_settings set month_start_day = 29 where household_id = $1`, [H.A])).toMatch(/check constraint/);
    expect((await db.as(as.viewerA2, `update public.household_settings set month_start_day = 5 where household_id = $1`, [H.A])).affected).toBe(0);
    expect((await db.as(as.ownerB, `update public.household_settings set month_start_day = 5 where household_id = $1`, [H.A])).affected).toBe(0);
    expect(await db.fails(as.memberA2, `select public.month_start_of($1)`, [H.A])).toMatch(/permission denied/);
  });

  it("start 10: alerts and the weekly summary follow the budget month", async () => {
    for (const t of ["transactions", "budget_alerts", "notification_queue"]) {
      await db.sql(`delete from public.${t} where household_id = $1`, [H.A]);
    }
    await ins("2026-10-09", "2026-10", 850);   // budget month September
    expect(await alerts()).toEqual(["2026-09:80"]);
    await ins("2026-10-10", "2026-10", 300);   // budget month October
    expect(await alerts()).toEqual(["2026-09:80"]);
    await ins("2026-11-09", "2026-11", 500);   // still October
    expect(await alerts()).toEqual(["2026-09:80", "2026-10:80"]);
    // moving a row's date across the start day moves it between budget months (trigger now watches `date`)
    await db.as(as.memberA2, `update public.transactions set date = '2026-10-12' where household_id = $1 and amount = 850`, [H.A]);
    expect(await alerts()).toEqual(["2026-09:80", "2026-10:80", "2026-10:100"]);

    // Sunday 25.10, 09:00 in Israel (winter time). Must not be > 3 days after the real clock, or the
    // "stale notifications are dropped" rule marks the fresh row as sent.
    const sunday = "2026-10-25T07:00:00Z";
    const due = (await db.as(as.service, `select * from public.svc_due_notifications($1)`, [sunday])).rows;
    const weekly = due.find((d) => d.endpoint === "https://push.example.test/m" && d.title === "סיכום שבועי");
    // budget month October = 10.10–9.11: 850 (moved to 12.10) + 300 + 500 (9.11); nothing in 19–25.10
    expect(weekly?.body).toBe("השבוע יצאו 0 ₪. מתחילת החודש: 1650 ₪.");
  });
});
