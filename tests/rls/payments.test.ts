// Payment methods + statement matching in the database (0008_payment_methods.sql):
// RLS, last4 only, composite FKs, apply_statement / merge_statement_row, receipt hint prefill.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
let card: string;   // household A's card (last4 4321)
let cashA: string;

const tx = (id: string) => db.sql(`select * from public.transactions where id = $1`, [id]).then((r) => r[0]);
const addTx = async (merchant: string, amount: number, date: string, pm: string | null, status = "awaiting_statement", source = "manual") =>
  (await db.as(as.memberA,
    `insert into public.transactions (household_id, date, month, merchant, amount, category, source, payment_method_id, match_status)
     values ($1, $2, $3, $4, $5, 'סופר ומכולת', $6, $7, $8) returning id`,
    [H.A, date, date.slice(0, 7), merchant, amount, source, pm, status])).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});
afterAll(async () => { await db?.close(); });

describe("payment_methods", () => {
  it("every household starts with cash / bit / transfer / other", async () => {
    const rows = await db.sql(`select id, household_id, type from public.payment_methods order by sort`);
    for (const h of [H.A, H.B]) {
      expect(rows.filter((r) => r.household_id === h).map((r) => r.type)).toEqual(["cash", "bit_paybox", "bank_transfer", "other"]);
    }
    cashA = rows.find((r) => r.household_id === H.A && r.type === "cash")!.id;
  });

  it("members add a card (last 4 digits only); viewers and other households can't", async () => {
    card = (await db.as(as.memberA, `insert into public.payment_methods (household_id, type, label, issuer, last4) values ($1, 'credit_card', 'מקס משותף', 'מקס', '4321') returning id`, [H.A])).rows[0].id;
    expect(await db.fails(as.memberA, `insert into public.payment_methods (household_id, type, label, last4) values ($1, 'credit_card', 'x', '4580123412341234')`, [H.A])).toMatch(/check constraint/);
    expect(await db.fails(as.memberA, `insert into public.payment_methods (household_id, type, label, last4) values ($1, 'credit_card', 'x', '12a4')`, [H.A])).toMatch(/check constraint/);
    expect(await db.fails(as.memberA, `insert into public.payment_methods (household_id, type, label) values ($1, 'crypto', 'x')`, [H.A])).toMatch(/check constraint/);
    expect(await db.fails(as.viewerA, `insert into public.payment_methods (household_id, type, label) values ($1, 'cash', 'x')`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerB, `insert into public.payment_methods (household_id, type, label) values ($1, 'cash', 'x')`, [H.A])).toMatch(/row-level security/);
    expect((await db.as(as.ownerB, `select * from public.payment_methods where household_id = $1`, [H.A])).rows).toHaveLength(0);
    expect((await db.as(as.viewerA, `select * from public.payment_methods where household_id = $1`, [H.A])).rows).toHaveLength(5);
    expect(await db.fails(as.anon, `select * from public.payment_methods`)).toMatch(/permission denied/);
  });

  it("an owner without the second factor (aal1) sees and changes nothing", async () => {
    expect((await db.as(as.ownerA1, `select * from public.payment_methods`)).rows).toHaveLength(0);
    expect((await db.as(as.ownerA1, `update public.payment_methods set label = 'x' where id = $1`, [card])).affected).toBe(0);
  });

  it("a transaction or fixed expense can't point at another household's method", async () => {
    const other = (await db.sql(`select id from public.payment_methods where household_id = $1 limit 1`, [H.B]))[0].id;
    expect(await db.fails(as.memberA, `insert into public.transactions (household_id, date, month, merchant, amount, category, payment_method_id) values ($1, '2026-08-01', '2026-08', 'x', 1, 'שונות', $2)`, [H.A, other])).toMatch(/foreign key/);
    expect(await db.fails(as.memberA, `insert into public.fixed_expenses (household_id, name, amount, keyword, category, payment_method_id) values ($1, 'x', 1, 'x', 'ביטוחים', $2)`, [H.A, other])).toMatch(/foreign key/);
    await db.as(as.memberA, `insert into public.fixed_expenses (household_id, name, amount, keyword, category, payment_method_id) values ($1, 'ביטוח רכב', 210, 'ביטוח ישיר', 'ביטוחים', $2)`, [H.A, card]);
  });
});

describe("apply_statement: import a card statement", () => {
  it("merges the waiting receipt, keeps cash, marks leftovers, inserts the rest — nothing counted twice", async () => {
    const r1 = await addTx("סופר השכונה", 120.5, "2026-08-10", card);
    const lost = await addTx("חנות הספרים", 80, "2026-08-12", card);
    const cash = await addTx("שוק", 64, "2026-08-10", cashA, "none");
    await db.sql(`insert into public.receipt_items (household_id, transaction_id, name, norm_name, date) values ($1, $2, 'חלב', 'חלב', '2026-08-10')`, [H.A, r1]);
    const before = await db.sql(`select coalesce(sum(amount),0)::numeric n from public.transactions where household_id = $1 and month = '2026-08'`, [H.A]);
    const rows = [
      { date: "2026-08-02", month: "2026-08", merchant: "דמי כרטיס", amount: 12, category: "עמלות וריבית", note: "", person_id: null, source: "import", source_title: "פירוט מקס" },
      { date: "2026-08-25", month: "2026-08", merchant: "חניון העירייה", amount: 18, category: "רכב, דלק וחניה", note: "", person_id: null, source: "import", source_title: "פירוט מקס" },
    ];
    const merges = [{ id: r1, date: "2026-08-11", month: "2026-08", amount: 121 }];
    expect(await db.fails(as.viewerA, `select public.apply_statement($1, $2, $3::jsonb, $4::jsonb, $5::uuid[])`, [H.A, card, JSON.stringify(rows), JSON.stringify(merges), [lost]])).toMatch(/not_allowed|permission denied/);
    const res = (await db.as(as.memberA, `select public.apply_statement($1, $2, $3::jsonb, $4::jsonb, $5::uuid[]) as r`,
      [H.A, card, JSON.stringify(rows), JSON.stringify(merges), [lost]])).rows[0].r;
    expect(res).toEqual({ inserted: 2, merged: 1, unmatched: 1 });
    const kept = await tx(r1);
    expect(kept).toMatchObject({ amount: "121.00", match_status: "matched", category: "סופר ומכולת", payment_method_id: card });
    expect((await db.sql(`select count(*)::int n from public.receipt_items where transaction_id = $1`, [r1]))[0].n).toBe(1); // line items survive
    expect((await tx(lost)).match_status).toBe("unmatched_after_statement");
    expect((await tx(cash)).match_status).toBe("none");
    const after = await db.sql(`select coalesce(sum(amount),0)::numeric n from public.transactions where household_id = $1 and month = '2026-08'`, [H.A]);
    expect(Number(after[0].n) - Number(before[0].n)).toBeCloseTo(0.5 + 12 + 18, 2); // the receipt was NOT added a second time
    const inserted = await db.sql(`select payment_method_id, match_status, created_by from public.transactions where household_id = $1 and source_title = 'פירוט מקס'`, [H.A]);
    expect(inserted.every((r) => r.payment_method_id === card && r.match_status === "none" && r.created_by === U.memberA)).toBe(true);
  });

  it("a stale merge (already matched) saves nothing", async () => {
    const done = (await db.sql(`select id from public.transactions where match_status = 'matched' limit 1`))[0].id;
    const rows = [{ date: "2026-08-20", month: "2026-08", merchant: "לא אמור להישמר", amount: 5, category: "שונות", source: "import" }];
    expect(await db.fails(as.memberA, `select public.apply_statement($1, $2, $3::jsonb, $4::jsonb, '{}')`,
      [H.A, card, JSON.stringify(rows), JSON.stringify([{ id: done, date: "2026-08-11", month: "2026-08", amount: 1 }])])).toMatch(/match_stale/);
    expect((await db.sql(`select count(*)::int n from public.transactions where merchant = 'לא אמור להישמר'`))[0].n).toBe(0);
  });

  it("another household can't apply a statement to A or with A's method", async () => {
    expect(await db.fails(as.ownerB, `select public.apply_statement($1, $2, '[]', '[]', '{}')`, [H.A, card])).toMatch(/not_allowed/);
    expect(await db.fails(as.ownerB, `select public.apply_statement($1, $2, '[]', '[]', '{}')`, [H.B, card])).toMatch(/not_found/);
  });
});

// bugs.md, 2026-09-30: a statement screenshot with no year printed ("עסקאות אחרונות") was saved
// 15 months off. 0009 does not silently correct or reject an implausible date — it keeps exactly
// what came back and flags the row, so it is visible in the app instead of hiding as normal.
describe("apply_statement: an implausible date is kept and flagged, not silently fixed (0009)", () => {
  const addDays = (n: number) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let today: string;
  beforeAll(async () => { today = (await db.sql(`select current_date::text as d`))[0].d; });

  it("a normal date inserts unflagged; a future date and a date >60 days old insert flagged — with THEIR OWN date, not substituted", async () => {
    const rows = [
      { date: addDays(-10), month: addDays(-10).slice(0, 7), merchant: "רגיל", amount: 20, category: "סופר ומכולת", source: "statement", source_title: "עסקאות אחרונות" },
      { date: addDays(5), month: addDays(5).slice(0, 7), merchant: "עתידי", amount: 21, category: "סופר ומכולת", source: "statement", source_title: "עסקאות אחרונות" },
      { date: addDays(-90), month: addDays(-90).slice(0, 7), merchant: "ישן", amount: 22, category: "סופר ומכולת", source: "statement", source_title: "עסקאות אחרונות" },
    ];
    await db.as(as.memberA, `select public.apply_statement($1, null, $2::jsonb, '[]', '{}')`, [H.A, JSON.stringify(rows)]);
    const saved = await db.sql(`select merchant, date::text as date, date_uncertain from public.transactions where source_title = 'עסקאות אחרונות' order by merchant`);
    expect(saved).toEqual([
      { merchant: "ישן", date: addDays(-90), date_uncertain: true },
      { merchant: "עתידי", date: addDays(5), date_uncertain: true },
      { merchant: "רגיל", date: addDays(-10), date_uncertain: false },
    ]);
  });

  it("exactly 60 days old is still fine; 61 is flagged (boundary)", async () => {
    const rows = [
      { date: addDays(-60), month: addDays(-60).slice(0, 7), merchant: "גבול60", amount: 1, category: "שונות", source: "statement" },
      { date: addDays(-61), month: addDays(-61).slice(0, 7), merchant: "גבול61", amount: 1, category: "שונות", source: "statement" },
    ];
    await db.as(as.memberA, `select public.apply_statement($1, null, $2::jsonb, '[]', '{}')`, [H.A, JSON.stringify(rows)]);
    expect((await db.sql(`select date_uncertain from public.transactions where merchant = 'גבול60'`))[0].date_uncertain).toBe(false);
    expect((await db.sql(`select date_uncertain from public.transactions where merchant = 'גבול61'`))[0].date_uncertain).toBe(true);
  });

  it("a merged row is flagged the same way (a statement can also overwrite a waiting row's date badly)", async () => {
    const waiting = await addTx("ציפייה לפירוט", 30, addDays(-8), null, "awaiting_statement");
    await db.as(as.memberA, `select public.apply_statement($1, null, '[]', $2::jsonb, '{}')`, [H.A, JSON.stringify([{ id: waiting, date: addDays(-90), month: addDays(-90).slice(0, 7), amount: 30 }])]);
    const got = await tx(waiting);
    expect(got.date.toISOString().slice(0, 10)).toBe(addDays(-90));
    expect(got).toMatchObject({ match_status: "matched", date_uncertain: true });
  });

  it("editing the transaction by hand (updateTx's column set) can clear the flag", async () => {
    const [row] = await db.sql(`select id from public.transactions where merchant = 'עתידי'`);
    await db.as(as.memberA, `update public.transactions set date = $2, month = $3, date_uncertain = false where id = $1`, [row.id, today, today.slice(0, 7)]);
    const got = await tx(row.id);
    expect(got.date.toISOString().slice(0, 10)).toBe(today);
    expect(got.date_uncertain).toBe(false);
  });

  it("a viewer can't clear it: RLS filters the row out, so the update touches nothing (same as every other column)", async () => {
    const [row] = await db.sql(`select id from public.transactions where merchant = 'ישן'`);
    const { affected } = await db.as(as.viewerA, `update public.transactions set date_uncertain = false where id = $1`, [row.id]);
    expect(affected).toBe(0);
    expect((await tx(row.id)).date_uncertain).toBe(true);   // unchanged
  });
});

describe("merge_statement_row: statement first, receipt later", () => {
  it("the receipt takes the statement row's amount/date; the statement row is removed", async () => {
    const st = await addTx("מאפיית הכיכר", 42, "2026-08-14", card, "none", "import");
    const rc = await addTx("מאפיית הכיכר", 41.6, "2026-08-13", card);
    expect(await db.fails(as.viewerA, `select public.merge_statement_row($1, $2)`, [rc, st])).toMatch(/permission denied|not_allowed|not_found|row-level/);
    await db.as(as.memberA, `select public.merge_statement_row($1, $2)`, [rc, st]);
    expect(await tx(st)).toBeUndefined();
    expect(await tx(rc)).toMatchObject({ amount: "42.00", match_status: "matched", matched_transaction_id: st });
    // can't merge into a non-statement row, or across households
    const other = (await db.sql(`select id from public.transactions where household_id = $1 limit 1`, [H.B]))[0].id;
    expect(await db.fails(as.memberA, `select public.merge_statement_row($1, $2)`, [rc, other])).toMatch(/not_found/);
  });
});

describe("receipt payment hint", () => {
  it("'אשראי ****4321' on the receipt prefills the card; 'מזומן' prefills cash", async () => {
    const res = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 2, 0.004) as r`, [H.A, U.memberA])).rows[0].r;
    const job = (await db.as(as.service,
      `select public.svc_record_receipt_job($1, $2, 'msgbatch_pm', 'claude-haiku-4-5', '[{"client_id":"p1"},{"client_id":"p2"}]'::jsonb, $3) as id`,
      [H.A, U.memberA, res.reservation_id])).rows[0].id;
    const rec = (id: string, payment: string) => ({ client_id: id, ok: true, receipt: { merchant: "סופר השכונה", date: "2026-09-20", total: 20.7, category: "סופר ומכולת", note: "", items: [], payment } });
    await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 100, 10, 0.0001)`, [job, JSON.stringify([rec("p1", "אשראי ****4321"), rec("p2", "מזומן")])]);
    const rows = await db.sql(`select receipt_client_id, payment_hint, payment_method_id, match_status from public.transactions where receipt_job_id = $1 order by receipt_client_id`, [job]);
    expect(rows).toEqual([
      { receipt_client_id: "p1", payment_hint: "אשראי ****4321", payment_method_id: card, match_status: "none" },
      { receipt_client_id: "p2", payment_hint: "מזומן", payment_method_id: cashA, match_status: "none" },
    ]);
  });
});
