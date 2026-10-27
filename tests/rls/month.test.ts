// Month boundaries in the database — the behavior BEFORE "budget month start" (feature 3).
// With the default start day (1) these must stay green after 0013.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

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
