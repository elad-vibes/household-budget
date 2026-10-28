// 0016: household region (Israel ₪ / Thailand ฿). Proves the Thailand household gets its own base currency,
// payment methods, cross rates, notification text and time zone — and that an Israeli household (H.A, with data)
// is not changed by any of it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
const T = "00000000-0000-4000-8000-0000000000cc";        // an empty household that moves to Thailand
const owner = { role: "authenticated", uid: U.outsider, aal: "aal2" } as const;
const plain = { role: "authenticated", uid: U.newbie, aal: "aal1" } as const;   // a member of T, not its owner

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`insert into public.households (id, name) values ('${T}', 'משק בית בתאילנד');
                insert into public.household_members (household_id, user_id, role) values ('${T}', '${U.outsider}', 'owner'), ('${T}', '${U.newbie}', 'member');
                insert into public.people (household_id, name, user_id) values ('${T}', 'נועה', '${U.outsider}')`);
});
afterAll(async () => { await db?.close(); });

const labels = (h: string) => db.sql(`select label from public.payment_methods where household_id = $1 order by sort`, [h]).then((r) => r.map((x) => x.label));
const rateFor = (hh: string, cur: string, on = "2026-10-26") =>
  db.as(as.service, `select public.fx_rate_for($1, $2, $3::date) as r`, [hh, cur, on]).then((r) => (r.rows[0].r === null ? null : Number(r.rows[0].r)));
const put = (rows: object[]) => db.as(as.service, `select public.svc_fx_put($1::jsonb, '2026-10-26T12:00:00Z'::timestamptz)`, [JSON.stringify(rows)]);

describe("the default is Israel — nothing changes for existing households", () => {
  it("region IL, base ILS, Israel time, the same four default payment methods", async () => {
    expect((await db.sql(`select region from public.household_settings where household_id = $1`, [H.A]))[0].region).toBe("IL");
    const r = (await db.as(as.service, `select public.base_currency($1) c, public.base_symbol($1) s, public.region_tz($1) tz`, [H.A])).rows[0];
    expect(r).toEqual({ c: "ILS", s: "₪", tz: "Asia/Jerusalem" });
    expect(await labels(H.A)).toEqual(["מזומן", "ביט / פייבוקס", "העברה", "אחר"]);
  });

  it("a household with money data can't change its region (even its owner), and neither can a plain member", async () => {
    expect(await db.fails(as.ownerA, `update public.household_settings set region = 'TH' where household_id = $1`, [H.A])).toMatch(/region_locked/);
    expect(await db.fails(as.memberA2, `update public.household_settings set region = 'TH' where household_id = $1`, [H.A])).toMatch(/not_allowed/);
    expect((await db.sql(`select region from public.household_settings where household_id = $1`, [H.A]))[0].region).toBe("IL");
  });
});

describe("moving an empty household to Thailand", () => {
  it("only its owner (or the super-admin) can; the defaults are swapped; trip mode starts off with ILS as the foreign currency", async () => {
    expect(await db.fails(plain, `update public.household_settings set region = 'TH' where household_id = $1`, [T])).toMatch(/not_allowed/);
    expect(await db.fails(owner, `update public.household_settings set region = 'XX' where household_id = $1`, [T])).toMatch(/check constraint/);
    expect(await labels(T)).toEqual(["מזומן", "ביט / פייבוקס", "העברה", "אחר"]);
    expect(await db.fails(owner, `update public.household_settings set region = 'TH' where household_id = $1`, [T])).toBeNull();
    expect(await labels(T)).toEqual(["מזומן", "PromptPay / Thai QR", "TrueMoney Wallet", "Rabbit LINE Pay", "העברה בנקאית", "אחר"]);
    expect((await db.sql(`select type, issuer from public.payment_methods where household_id = $1 and label like 'TrueMoney%'`, [T]))[0])
      .toEqual({ type: "e_wallet", issuer: "TrueMoney" });
    expect((await db.sql(`select region, trip_mode, trip_currency from public.household_settings where household_id = $1`, [T]))[0])
      .toEqual({ region: "TH", trip_mode: false, trip_currency: "ILS" });
    const r = (await db.as(as.service, `select public.base_currency($1) c, public.base_symbol($1) s, public.region_tz($1) tz, public.svc_household_region($1) rg`, [T])).rows[0];
    expect(r).toEqual({ c: "THB", s: "฿", tz: "Asia/Bangkok", rg: "TH" });
  });

  it("the foreign currency of a Thai household is never baht; an Israeli one is never the shekel (as before)", async () => {
    const ins = (actor: typeof owner | typeof as.memberA2, h: string, cur: string) => db.fails(actor,
      `insert into public.transactions (household_id, date, month, merchant, amount, category, original_amount, original_currency, fx_rate)
       values ($1, '2026-10-20', '2026-10', 'ร้านอาหาร', 100, 'שונות', 10, $2, 1)`, [h, cur]);
    expect(await ins(owner, T, "THB")).toMatch(/check constraint/);
    expect(await ins(as.memberA2, H.A, "ILS")).toMatch(/check constraint/);
    expect(await db.fails(owner, `update public.household_settings set trip_currency = 'THB' where household_id = $1`, [T])).toMatch(/check constraint/);
    expect(await db.fails(owner, `update public.household_settings set trip_currency = 'USD' where household_id = $1`, [T])).toBeNull();
    expect(await db.fails(owner, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'THB', 1)`, [T])).toMatch(/check constraint/);
  });

  it("an e-wallet method can be added and is accepted by the type check", async () => {
    expect(await db.fails(owner, `insert into public.payment_methods (household_id, type, label, issuer) values ($1, 'e_wallet', 'Lazada Wallet', 'Lazada')`, [T])).toBeNull();
    expect(await db.fails(owner, `insert into public.payment_methods (household_id, type, label) values ($1, 'crypto', 'x')`, [T])).toMatch(/check constraint/);
  });
});

describe("exchange rates in the household's base currency", () => {
  it("a Thai household gets cross rates through the shekel; an Israeli household's rates are untouched; a manual rate wins", async () => {
    await put([{ currency: "THB", date: "2026-10-26", rate: 0.0911, source: "ecb" }, { currency: "USD", date: "2026-10-26", rate: 3.078, source: "boi" },
               { currency: "EUR", date: "2026-10-26", rate: 3.4462, source: "boi" }]);
    expect(await rateFor(H.A, "USD")).toBe(3.078);                         // Israel: exactly the cached rate
    expect(await rateFor(H.A, "THB")).toBe(0.0911);
    expect(await rateFor(T, "USD")).toBeCloseTo(3.078 / 0.0911, 5);        // ฿ per $
    expect(await rateFor(T, "ILS")).toBeCloseTo(1 / 0.0911, 5);            // ฿ per ₪
    expect(await rateFor(T, "XAF")).toBeNull();
    await db.as(owner, `insert into public.fx_overrides (household_id, currency, ils_per_unit) values ($1, 'USD', 34.5)`, [T]);
    expect(await rateFor(T, "USD")).toBe(34.5);
    expect(await rateFor(H.A, "USD")).toBe(3.078);
  });

  it("svc_fx_rates answers in the household's base: official rates incl. the shekel, no baht; sources say 'cross' when two feeds were crossed", async () => {
    const th = (await db.as(as.service, `select public.svc_fx_rates($1) as r`, [T])).rows[0].r;
    expect(th.base).toBe("THB");
    expect(th.official.THB).toBeUndefined();
    expect(th.official.ILS).toMatchObject({ source: "ecb", date: "2026-10-26" });
    expect(th.official.ILS.rate).toBeCloseTo(10.976948, 5);
    expect(th.official.USD.source).toBe("cross");
    expect(th.manual.USD.rate).toBe(34.5);
    const il = (await db.as(as.service, `select public.svc_fx_rates($1) as r`, [H.A])).rows[0].r;
    expect(il.base).toBe("ILS");
    expect(il.official.USD).toMatchObject({ rate: 3.078, source: "boi" });
    expect(il.official.ILS).toBeUndefined();
  });
});

describe("receipts and the iPhone capture in a Thai household", () => {
  it("a receipt in baht stays as is; a shekel receipt is the foreign one; no currency means baht; no rate → unconverted + noted in baht words", async () => {
    await db.as(owner, `delete from public.fx_overrides where household_id = $1`, [T]);
    const res = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 4, 0.006) as r`, [T, U.outsider])).rows[0].r;
    const job = (await db.as(as.service,
      `select public.svc_record_receipt_job($1, $2, 'msgbatch_th', 'claude-haiku-4-5', '[{"client_id":"t1"},{"client_id":"t2"},{"client_id":"t3"},{"client_id":"t4"}]'::jsonb, $3) as id`,
      [T, U.outsider, res.reservation_id])).rows[0].id;
    const rec = (id: string, total: number, currency: string) => ({ client_id: id, ok: true,
      receipt: { merchant: "7-Eleven", date: "2026-10-25", total, currency, category: "סופר ומכולת", note: "", items: [], payment: "" } });
    await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 100, 10, 0.0001)`,
      [job, JSON.stringify([rec("t1", 350, "THB"), rec("t2", 42.9, "ILS"), rec("t3", 120, ""), rec("t4", 12, "XAF")])]);
    const rows = await db.sql(`select receipt_client_id c, amount, original_amount, original_currency, note from public.transactions
                                where receipt_job_id = $1 order by receipt_client_id`, [job]);
    expect(rows[0]).toEqual({ c: "t1", amount: "350.00", original_amount: null, original_currency: null, note: "" });
    expect(rows[1]).toMatchObject({ c: "t2", amount: "470.91", original_amount: "42.90", original_currency: "ILS" });
    expect(rows[2]).toEqual({ c: "t3", amount: "120.00", original_amount: null, original_currency: null, note: "" });
    expect(rows[3]).toEqual({ c: "t4", amount: "12.00", original_amount: null, original_currency: null, note: "סכום ב-XAF, לא הומר לבאט — צריך לתקן" });
  });

  it("capture: the token knows the region; baht is the base; a quick add is in baht; a dollar amount is converted to baht", async () => {
    const token = (await db.as(owner, `select public.create_capture_token($1, 'אייפון') as t`, [T])).rows[0].t;
    expect((await db.as(as.service, `select public.svc_capture_region($1) as r`, [token])).rows[0].r).toBe("TH");
    expect((await db.as(as.service, `select public.svc_capture_region('hbc_nope') as r`)).rows[0].r).toBe("IL");
    const cap = (amount: number, merchant: string, kind: string, currency: string) => db.as(as.service,
      `select public.svc_capture($1, $2, $3, '', $4, null, true, '', '2026-10-26'::date, $5) as r`, [token, amount, merchant, kind, currency]).then((x) => x.rows[0].r);
    expect(await cap(200, "Big C", "wallet", "THB")).toMatchObject({ ok: true, amount: 200, original_amount: null, currency: "THB" });
    expect(await cap(80, "ข้าวมันไก่", "quick", "")).toMatchObject({ amount: 80, original_amount: null, currency: "THB" });
    const usd = await cap(10, "Hotel", "wallet", "USD");
    expect(usd).toMatchObject({ original_amount: 10, currency: "USD" });
    expect(usd.amount).toBeCloseTo(10 * (3.078 / 0.0911), 1);
  });
});

describe("notifications and time zone follow the region", () => {
  it("budget alerts use the household's sign; a new user's defaults follow the household (Monday + Bangkok for Thailand)", async () => {
    await db.as(owner, `insert into public.budgets (household_id, category, amount) values ($1, 'סופר ומכולת', 100)`, [T]);
    await db.as(owner, `insert into public.transactions (household_id, date, month, merchant, amount, category, status) values ($1, '2026-10-26', '2026-10', 'Lotus''s', 95, 'סופר ומכולת', 'saved')`, [T]);
    await db.sql(`insert into public.budgets (household_id, category, amount) values ('${H.A}', 'סופר ומכולת', 100) on conflict do nothing`);
    await db.as(as.memberA2, `insert into public.transactions (household_id, date, month, merchant, amount, category, status) values ($1, '2026-10-26', '2026-10', 'שופרסל', 95, 'סופר ומכולת', 'saved')`, [H.A]);
    const body = (h: string) => db.sql(`select body from public.notification_queue where household_id = $1 and kind = 'budget' limit 1`, [h]).then((r) => r[0]?.body as string);
    expect(await body(T)).toContain("฿");
    expect(await body(T)).not.toContain("₪");
    expect(await body(H.A)).toContain("₪");
    const p = (u: string) => db.as(as.service, `select (public.prefs_of($1)).tz tz, (public.prefs_of($1)).weekly_day wd`, [u]).then((r) => r.rows[0]);
    expect(await p(U.outsider)).toEqual({ tz: "Asia/Bangkok", wd: 1 });
    expect(await p(U.ownerA)).toEqual({ tz: "Asia/Jerusalem", wd: 0 });
  });

  it("once a Thai household holds money data its region is locked", async () => {
    expect(await db.fails(owner, `update public.household_settings set region = 'IL' where household_id = $1`, [T])).toMatch(/region_locked/);
  });
});
