// 0015_trip_mode.sql: foreign currency — original amount on transactions, trip-mode settings,
// the shared official-rate cache (service only), manual rate per household (RLS), and the
// conversion in receipts / iPhone capture / statement import + merge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});
afterAll(async () => { await db?.close(); });

const put = (rows: object[], now = "2026-10-26T12:00:00Z") =>
  db.as(as.service, `select public.svc_fx_put($1::jsonb, $2::timestamptz) as n`, [JSON.stringify(rows), now]).then((r) => r.rows[0].n);
const claim = (now: string) => db.as(as.service, `select public.svc_fx_claim($1::timestamptz) as ok`, [now]).then((r) => r.rows[0].ok);
const rateFor = (hh: string, cur: string, on: string) =>
  db.as(as.service, `select public.fx_rate_for($1, $2, $3::date) as r`, [hh, cur, on]).then((r) => (r.rows[0].r === null ? null : Number(r.rows[0].r)));

describe("transactions keep the original amount (0015)", () => {
  it("original amount, currency and rate come together or not at all; ₪ is never an 'original'", async () => {
    const ins = (orig: unknown, cur: unknown, rate: unknown) => db.fails(as.memberA2,
      `insert into public.transactions (household_id, date, month, merchant, amount, category, original_amount, original_currency, fx_rate)
       values ($1, '2026-10-20', '2026-10', 'שוק לילה', 31.89, 'אוכל בחוץ', $2, $3, $4)`, [H.A, orig, cur, rate]);
    expect(await ins(350, "THB", 0.0911)).toBeNull();
    expect(await ins(350, "THB", null)).toMatch(/check constraint/);
    expect(await ins(350, null, null)).toMatch(/check constraint/);
    expect(await ins(350, "ILS", 1)).toMatch(/check constraint/);
    expect(await ins(350, "thb", 0.0911)).toMatch(/check constraint/);
    expect(await ins(350, "THB", 0)).toMatch(/check constraint/);
    const t = (await db.sql(`select id from public.transactions where merchant = 'שוק לילה' limit 1`))[0].id;
    expect(await db.fails(as.memberA2, `update public.transactions set original_amount = 400, fx_rate = 0.09 where id = $1`, [t])).toBeNull();
    expect(await db.fails(as.viewerA2, `update public.transactions set fx_rate = 1 where id = $1`, [t])).toBeNull();   // RLS: 0 rows, no error
    expect(Number((await db.sql(`select fx_rate from public.transactions where id = $1`, [t]))[0].fx_rate)).toBe(0.09);
  });

  it("trip mode + currency are household settings a member can change; ILS is not a trip currency", async () => {
    expect((await db.sql(`select trip_mode, trip_currency from public.household_settings where household_id = $1`, [H.A]))[0])
      .toEqual({ trip_mode: false, trip_currency: "THB" });
    await db.as(as.memberA2, `update public.household_settings set trip_mode = true, trip_currency = 'USD' where household_id = $1`, [H.A]);
    expect((await db.sql(`select trip_mode, trip_currency from public.household_settings where household_id = $1`, [H.A]))[0])
      .toEqual({ trip_mode: true, trip_currency: "USD" });
    expect(await db.fails(as.memberA2, `update public.household_settings set trip_currency = 'ILS' where household_id = $1`, [H.A])).toMatch(/check constraint/);
    await db.as(as.memberA2, `update public.household_settings set trip_mode = false, trip_currency = 'THB' where household_id = $1`, [H.A]);
  });
});

describe("official rates (shared cache, service only)", () => {
  it("users can't read or write the cache or its bookkeeping", async () => {
    expect(await db.fails(as.memberA2, `select * from public.fx_rates`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA2, `insert into public.fx_rates (rate_date, currency, ils_per_unit, source) values ('2026-10-26', 'THB', 1, 'boi')`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA2, `select * from public.fx_meta`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA2, `select public.svc_fx_put('[]'::jsonb, now())`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA2, `select public.fx_rate_for($1, 'THB', '2026-10-26')`, [H.A])).toMatch(/permission denied/);
    expect(await db.fails(as.anon, `select public.svc_fx_rates($1)`, [H.A])).toMatch(/permission denied/);
  });

  it("fetch at most once a day (again after the 13:30 publication), retry a failure after 30 minutes", async () => {
    expect(await claim("2026-10-26T05:00:00Z")).toBe(true);    // 08:00 Israel, nothing yet
    expect(await claim("2026-10-26T05:10:00Z")).toBe(false);   // a failed attempt 10 min ago
    expect(await claim("2026-10-26T05:31:00Z")).toBe(true);    // 30 min later: try again
    await put([{ currency: "USD", date: "2026-10-23", rate: 3.1, source: "boi" }], "2026-10-26T05:31:00Z");
    expect(await claim("2026-10-26T09:00:00Z")).toBe(false);   // 12:00 Israel — the morning fetch counts
    expect(await claim("2026-10-26T12:00:00Z")).toBe(true);    // 15:00 Israel — today's rate is out
    await put([{ currency: "USD", date: "2026-10-26", rate: 3.078, source: "boi" }], "2026-10-26T12:00:00Z");
    expect(await claim("2026-10-26T18:00:00Z")).toBe(false);
    expect(await claim("2026-10-27T05:00:00Z")).toBe(true);    // next day
  });

  it("a Bank of Israel rate is never replaced by an ECB cross rate; the latest one ≤ the day is used", async () => {
    await put([{ currency: "USD", date: "2026-10-26", rate: 3.5, source: "ecb" }, { currency: "THB", date: "2026-10-23", rate: 0.0905, source: "ecb" },
      { currency: "THB", date: "2026-10-26", rate: 0.0911, source: "ecb" }]);
    expect(await rateFor(H.A, "USD", "2026-10-26")).toBe(3.078);
    expect(await rateFor(H.A, "THB", "2026-10-25")).toBe(0.0905);   // Sunday → Friday's rate
    expect(await rateFor(H.A, "THB", "2026-10-26")).toBe(0.0911);
    expect(await rateFor(H.A, "THB", "2026-01-01")).toBe(0.0905);   // before our first rate → the earliest we have
    expect(await rateFor(H.A, "XAF", "2026-10-26")).toBeNull();
    const r = (await db.as(as.service, `select public.svc_fx_rates($1) as r`, [H.A])).rows[0].r;
    expect(r.official.THB).toEqual({ rate: 0.0911, date: "2026-10-26", source: "ecb" });
    expect(r.official.USD).toEqual({ rate: 3.078, date: "2026-10-26", source: "boi" });
    expect(r.manual).toEqual({});
  });
});

describe("manual rate per household (fx_overrides)", () => {
  it("members set it, viewers and other households can't; it wins over the official rate", async () => {
    expect(await db.fails(as.memberA2, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'THB', 0.095)`, [H.A])).toBeNull();
    expect(await db.fails(as.viewerA2, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'USD', 3)`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerB, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'USD', 3)`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.memberA, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'EUR', 3)`, [H.A])).toBeNull(); // member at aal1 is fine
    expect((await db.as(as.ownerB, `select * from public.fx_overrides`)).rows).toHaveLength(0);
    expect((await db.as(as.viewerA2, `select currency from public.fx_overrides order by currency`)).rows).toEqual([{ currency: "EUR" }, { currency: "THB" }]);
    expect(await db.fails(as.memberA2, `update public.fx_overrides set household_id = $1 where currency = 'THB'`, [H.B])).toMatch(/permission denied/);
    expect(await rateFor(H.A, "THB", "2026-10-26")).toBe(0.095);
    expect(await rateFor(H.B, "THB", "2026-10-26")).toBe(0.0911);
    expect((await db.as(as.service, `select public.svc_fx_rates($1) as r`, [H.A])).rows[0].r.manual.THB.rate).toBe(0.095);
    await db.as(as.memberA2, `delete from public.fx_overrides where household_id = $1`, [H.A]);
    expect(await rateFor(H.A, "THB", "2026-10-26")).toBe(0.0911);
  });
});

describe("conversion on the way in", () => {
  it("a receipt in baht keeps the original and is converted with the rate of its date; no rate → unconverted + noted", async () => {
    const res = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 3, 0.006) as r`, [H.A, U.memberA])).rows[0].r;
    const job = (await db.as(as.service,
      `select public.svc_record_receipt_job($1, $2, 'msgbatch_fx', 'claude-haiku-4-5', '[{"client_id":"f1"},{"client_id":"f2"},{"client_id":"f3"}]'::jsonb, $3) as id`,
      [H.A, U.memberA, res.reservation_id])).rows[0].id;
    const rec = (id: string, total: number, currency: string) => ({ client_id: id, ok: true,
      receipt: { merchant: "7-Eleven", date: "2026-10-25", total, currency, category: "סופר ומכולת", note: "", items: [], payment: "" } });
    await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 100, 10, 0.0001)`,
      [job, JSON.stringify([rec("f1", 350, "THB"), rec("f2", 42.9, "ILS"), rec("f3", 12, "XAF")])]);
    const rows = await db.sql(`select receipt_client_id c, amount, original_amount, original_currency, fx_rate, note from public.transactions
                                where receipt_job_id = $1 order by receipt_client_id`, [job]);
    expect(rows).toEqual([
      { c: "f1", amount: "31.68", original_amount: "350.00", original_currency: "THB", fx_rate: "0.090500", note: "" },  // 350 × 0.0905
      { c: "f2", amount: "42.90", original_amount: null, original_currency: null, fx_rate: null, note: "" },
      { c: "f3", amount: "12.00", original_amount: null, original_currency: null, fx_rate: null, note: "סכום ב-XAF, לא הומר לשקלים — צריך לתקן" },
    ]);
  });

  it("iPhone capture: a foreign amount is converted; a quick add uses the trip currency only in trip mode", async () => {
    const token = (await db.as(as.memberA, `select public.create_capture_token($1, 'אייפון') as t`, [H.A])).rows[0].t;
    const cap = (amount: number, merchant: string, kind: string, currency: string) => db.as(as.service,
      `select public.svc_capture($1, $2, $3, '', $4, $5, true, '', '2026-10-26'::date, $6) as r`,
      [token, amount, merchant, kind, kind === "quick" ? "אוכל בחוץ" : null, currency]).then((x) => x.rows[0].r);
    const w = await cap(200, "Big C", "wallet", "THB");
    expect(w).toMatchObject({ ok: true, status: "saved", amount: 18.22, original_amount: 200, currency: "THB" });
    const q1 = await cap(100, "פאד תאי", "quick", "");                      // trip mode off → ₪
    expect(q1).toMatchObject({ amount: 100, original_amount: null, currency: "ILS" });
    await db.as(as.memberA2, `update public.household_settings set trip_mode = true where household_id = $1`, [H.A]);
    const q2 = await cap(100, "פאד תאי ליד המלון", "quick", "");            // trip mode on → THB
    expect(q2).toMatchObject({ status: "saved", amount: 9.11, original_amount: 100, currency: "THB" });
    const q3 = await cap(50, "מונית", "quick", "XAF");                      // no rate → review, unconverted
    expect(q3).toMatchObject({ status: "review", amount: 50, original_amount: null, currency: "ILS" });
    expect((await db.sql(`select note from public.transactions where id = $1`, [q3.id]))[0].note).toMatch(/^סכום ב-XAF/);
    await db.as(as.memberA2, `update public.household_settings set trip_mode = false where household_id = $1`, [H.A]);
  });

  it("statement rows keep their original; merging into a logged foreign row stores the card's actual rate", async () => {
    const card = (await db.as(as.memberA, `insert into public.payment_methods (household_id, type, label, last4) values ($1, 'credit_card', 'כרטיס לחו״ל', '8765') returning id`, [H.A])).rows[0].id;
    const logged = (await db.as(as.memberA2, `insert into public.transactions (household_id, date, month, merchant, amount, category, payment_method_id,
        match_status, original_amount, original_currency, fx_rate) values ($1, '2026-10-24', '2026-10', 'מלון בצ׳יאנג מאי', 273.30, 'חופשות', $2,
        'awaiting_statement', 3000, 'THB', 0.0911) returning id`, [H.A, card])).rows[0].id;
    const rows = [{ date: "2026-10-22", month: "2026-10", merchant: "AIRASIA", amount: 412.5, category: "חופשות", source: "statement",
      original_amount: 110, original_currency: "USD", fx_rate: 3.75 }];
    const merges = [{ id: logged, date: "2026-10-24", month: "2026-10", amount: 281.4 }];
    await db.as(as.memberA2, `select public.apply_statement($1, $2, $3::jsonb, $4::jsonb, '{}')`, [H.A, card, JSON.stringify(rows), JSON.stringify(merges)]);
    expect((await db.sql(`select amount, original_amount, original_currency, fx_rate from public.transactions where merchant = 'AIRASIA'`))[0])
      .toEqual({ amount: "412.50", original_amount: "110.00", original_currency: "USD", fx_rate: "3.750000" });
    expect((await db.sql(`select amount, original_amount, original_currency, fx_rate, match_status from public.transactions where id = $1`, [logged]))[0])
      .toEqual({ amount: "281.40", original_amount: "3000.00", original_currency: "THB", fx_rate: "0.093800", match_status: "matched" });
  });
});
