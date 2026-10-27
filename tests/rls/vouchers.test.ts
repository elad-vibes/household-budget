// 0014_vouchers.sql: voucher wallet — RLS, balance math kept by triggers, reminders 30/7/1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example.test/v', $2, $3)`,
    [U.ownerA, "B".repeat(87), "a".repeat(22)]);
});
afterAll(async () => { await db?.close(); });

const newVoucher = async (name: string, amount: number, expires: string | null = null) =>
  (await db.as(as.memberA2, `insert into public.vouchers (household_id, name, issuer, initial_amount, expires_on, code_last4)
    values ($1, $2, 'רשת לדוגמה', $3, $4, '4321') returning id, payment_method_id, balance`, [H.A, name, amount, expires])).rows[0];
const balance = async (id: string) => Number((await db.sql(`select balance from public.vouchers where id = $1`, [id]))[0].balance);
const pay = async (method: string, amount: number, status = "saved") =>
  (await db.as(as.memberA2, `insert into public.transactions (household_id, date, month, merchant, amount, category, payment_method_id, status)
    values ($1, '2026-10-05', '2026-10', 'חנות לדוגמה', $2, 'קניות אונליין', $3, $4) returning id`, [H.A, amount, method, status])).rows[0].id;

describe("vouchers (0014)", () => {
  it("a new voucher gets its own payment method and starts at its full value", async () => {
    const v = await newVoucher("תו קנייה", 500);
    expect(Number(v.balance)).toBe(500);
    const [pm] = await db.sql(`select type, label, active from public.payment_methods where id = $1`, [v.payment_method_id]);
    expect(pm).toEqual({ type: "voucher", label: "שובר: תו קנייה", active: true });
  });

  it("members write, viewers can't, another household can't even see it", async () => {
    expect(await db.fails(as.viewerA2, `insert into public.vouchers (household_id, name, initial_amount) values ($1, 'x', 10)`, [H.A])).toMatch(/row-level security/);
    expect((await db.as(as.ownerB, `select * from public.vouchers`)).rows).toHaveLength(0);
    expect((await db.as(as.ownerB, `select * from public.voucher_uses`)).rows).toHaveLength(0);
    expect(await db.fails(as.ownerB, `insert into public.vouchers (household_id, name, initial_amount) values ($1, 'x', 10)`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.memberA2, `update public.vouchers set balance = 9999`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA2, `insert into public.vouchers (household_id, name, initial_amount, code_last4) values ($1, 'x', 10, '12345678')`, [H.A])).toMatch(/check constraint/);
  });

  it("paying with it lowers the balance; edits, review, method change and delete keep it right", async () => {
    const v = await newVoucher("גיפט קארד", 300);
    const t = await pay(v.payment_method_id, 120);
    expect(await balance(v.id)).toBe(180);
    await db.as(as.memberA2, `update public.transactions set amount = 150 where id = $1`, [t]);
    expect(await balance(v.id)).toBe(150);
    await db.as(as.memberA2, `update public.transactions set status = 'review' where id = $1`, [t]);
    expect(await balance(v.id)).toBe(300);
    await db.as(as.memberA2, `update public.transactions set status = 'saved' where id = $1`, [t]);
    expect(await balance(v.id)).toBe(150);
    const cash = (await db.sql(`select id from public.payment_methods where household_id = $1 and type = 'cash'`, [H.A]))[0].id;
    await db.as(as.memberA2, `update public.transactions set payment_method_id = $2 where id = $1`, [t, cash]);
    expect(await balance(v.id)).toBe(300);
    await db.as(as.memberA2, `update public.transactions set payment_method_id = $2 where id = $1`, [t, v.payment_method_id]);
    expect(await balance(v.id)).toBe(150);
    const uses = await db.as(as.memberA2, `select amount, note, transaction_id from public.voucher_uses where voucher_id = $1`, [v.id]);
    expect(uses.rows).toEqual([{ amount: "150.00", note: "חנות לדוגמה", transaction_id: t }]);
    await db.as(as.memberA2, `delete from public.transactions where id = $1`, [t]);
    expect(await balance(v.id)).toBe(300);
    const pending = await pay(v.payment_method_id, 50, "review");   // a receipt still under review doesn't spend it
    expect(await balance(v.id)).toBe(300);
    await db.as(as.memberA2, `delete from public.transactions where id = $1`, [pending]);
  });

  it("manual uses and top-ups; trigger-made uses can't be faked or removed by hand", async () => {
    const v = await newVoucher("זיכוי בחנות", 200);
    await db.as(as.memberA2, `insert into public.voucher_uses (household_id, voucher_id, amount, note) values ($1, $2, 80, 'קנייה בקופה')`, [H.A, v.id]);
    expect(await balance(v.id)).toBe(120);
    await db.as(as.memberA2, `insert into public.voucher_uses (household_id, voucher_id, amount, note) values ($1, $2, -30, 'טעינה')`, [H.A, v.id]);
    expect(await balance(v.id)).toBe(150);
    const t = await pay(v.payment_method_id, 40);
    expect(await db.fails(as.memberA2, `insert into public.voucher_uses (household_id, voucher_id, transaction_id, amount) values ($1, $2, $3, 1)`, [H.A, v.id, t])).toMatch(/permission denied/);
    expect((await db.as(as.memberA2, `delete from public.voucher_uses where transaction_id = $1`, [t])).affected).toBe(0);
    expect(await db.fails(as.viewerA2, `insert into public.voucher_uses (household_id, voucher_id, amount) values ($1, $2, 5)`, [H.A, v.id])).toMatch(/row-level security/);
    await db.as(as.memberA2, `update public.vouchers set initial_amount = 250 where id = $1`, [v.id]);
    expect(await balance(v.id)).toBe(160);   // 250 − 80 + 30 − 40
  });

  it("archiving hides its payment method; deleting removes the method and unlinks old expenses", async () => {
    const v = await newVoucher("ישן", 100);
    const t = await pay(v.payment_method_id, 10);
    await db.as(as.memberA2, `update public.vouchers set archived = true where id = $1`, [v.id]);
    expect((await db.sql(`select active from public.payment_methods where id = $1`, [v.payment_method_id]))[0].active).toBe(false);
    await db.as(as.memberA2, `delete from public.vouchers where id = $1`, [v.id]);
    expect(await db.sql(`select 1 from public.payment_methods where id = $1`, [v.payment_method_id])).toHaveLength(0);
    expect((await db.sql(`select payment_method_id from public.transactions where id = $1`, [t]))[0].payment_method_id).toBeNull();
  });

  it("expiry reminders: one per window (30 / 7 / 1), only with money left", async () => {
    await db.sql(`delete from public.vouchers where household_id = $1`, [H.A]);
    await newVoucher("שבוע", 100, "2026-10-27");     // 7 days
    await newVoucher("חודש", 100, "2026-11-19");     // 30 days
    await newVoucher("רחוק", 100, "2026-11-25");     // 36 days → nothing yet
    await newVoucher("מחר", 100, "2026-10-21");      // 1 day
    const empty = await newVoucher("נוצל", 50, "2026-10-21");
    await db.as(as.memberA2, `insert into public.voucher_uses (household_id, voucher_id, amount) values ($1, $2, 50)`, [H.A, empty.id]);
    const keys = async () => (await db.sql(`select title, split_part(dedupe_key, ':', 2) as win from public.notification_queue
      where household_id = $1 and kind = 'voucher' order by title`, [H.A])).map((r) => `${r.title}|${r.win}`);
    // 10:00 Israel time, all before the real clock (the "stale" rule drops rows created > 3 days before p_now)
    await db.as(as.service, `select * from public.svc_due_notifications($1)`, ["2026-10-20T07:00:00Z"]);
    expect(await keys()).toEqual(["שובר עומד לפוג: חודש|30", "שובר עומד לפוג: מחר|1", "שובר עומד לפוג: שבוע|7"]);
    await db.as(as.service, `select * from public.svc_due_notifications($1)`, ["2026-10-21T07:00:00Z"]);
    expect(await keys()).toHaveLength(3);   // same windows → nothing new
    await db.as(as.service, `select * from public.svc_due_notifications($1)`, ["2026-10-26T08:00:00Z"]);
    expect(await keys()).toContain("שובר עומד לפוג: שבוע|1");
    const body = (await db.sql(`select body from public.notification_queue where kind = 'voucher' and title like '%שבוע' and dedupe_key like '%:1'`))[0].body;
    expect(body).toBe("מחר · יתרה 100 ₪.");
  });
});
