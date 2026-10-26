// 0011_capture.sql: capture tokens (hashed, shown once, rotation/revoke), svc_capture
// (scope, dedup, payment method, review vs saved) and the statement merge of a wallet row.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
let card: string;
const cap = (token: string, amount: number, merchant: string, over: Record<string, unknown> = {}) => {
  const a = { card: "", kind: "wallet", category: null, known: false, note: "", date: "2026-10-20", ...over };
  return db.as(as.service, `select public.svc_capture($1, $2, $3, $4, $5, $6, $7, $8, $9::date) as r`,
    [token, amount, merchant, a.card, a.kind, a.category, a.known, a.note, a.date]).then((x) => x.rows[0].r);
};

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  card = (await db.as(as.memberA, `insert into public.payment_methods (household_id, type, label, issuer, last4) values ($1, 'credit_card', 'מקס משותף', 'מקס', '4321') returning id`, [H.A])).rows[0].id;
});
afterAll(async () => { await db?.close(); });

describe("capture tokens", () => {
  it("a writer gets a token once; only its hash is stored; viewers and outsiders can't", async () => {
    const t = (await db.as(as.memberA, `select public.create_capture_token($1, 'אייפון') as t`, [H.A])).rows[0].t;
    expect(t).toMatch(/^hbc_[0-9a-f]{64}$/);
    expect((await db.sql(`select count(*)::int n from public.capture_tokens where token_hash = $1`, [t]))[0].n).toBe(0);
    expect(await db.fails(as.viewerA, `select public.create_capture_token($1)`, [H.A])).toMatch(/not_allowed/);
    expect(await db.fails(as.ownerB, `select public.create_capture_token($1)`, [H.A])).toMatch(/not_allowed/);
    expect(await db.fails(as.memberA, `select token_hash from public.capture_tokens`)).toMatch(/permission denied/);
    expect((await db.as(as.memberA, `select id, label from public.capture_tokens`)).rows).toHaveLength(1);
    expect((await db.as(as.ownerA, `select id from public.capture_tokens`)).rows).toHaveLength(0); // other users' tokens are invisible
    expect(await db.fails(as.memberA, `select public.svc_capture('x', 1, 'x', '', 'wallet', null, false, '', '2026-10-01')`)).toMatch(/permission denied/);
  });

  it("rotation revokes the old token; revoke stops it", async () => {
    const t1 = (await db.as(as.memberA, `select public.create_capture_token($1) as t`, [H.A])).rows[0].t;
    const t2 = (await db.as(as.memberA, `select public.create_capture_token($1) as t`, [H.A])).rows[0].t;
    expect(await cap(t1, 10, "בדיקה")).toEqual({ ok: false, reason: "bad_token" });
    expect((await cap(t2, 10, "בדיקה")).ok).toBe(true);
    await db.as(as.memberA, `select public.revoke_capture_tokens($1)`, [H.A]);
    expect(await cap(t2, 11, "בדיקה")).toEqual({ ok: false, reason: "bad_token" });
  });
});

describe("svc_capture", () => {
  let token: string;
  beforeAll(async () => { token = (await db.as(as.memberA, `select public.create_capture_token($1) as t`, [H.A])).rows[0].t; });

  it("wallet: the card by its last 4, waits for the statement, review unless a rule knew the merchant", async () => {
    const r = await cap(token, 45.9, "מאפיית הכיכר", { card: "Max ••4321" });
    expect(r).toMatchObject({ ok: true, duplicate: false, status: "review", method: "מקס משותף" });
    const row = (await db.sql(`select * from public.transactions where id = $1`, [r.id]))[0];
    expect(row).toMatchObject({ household_id: H.A, source: "wallet", amount: "45.90", status: "review", match_status: "awaiting_statement",
      payment_method_id: card, created_by: U.memberA, month: "2026-10" });
    const known = await cap(token, 312.4, "שופרסל דיל", { category: "סופר ומכולת", known: true });
    expect(known.status).toBe("saved");
  });

  it("the same purchase twice within 2 minutes is saved once", async () => {
    expect((await cap(token, 19.9, "קפה גן")).duplicate).toBe(false);
    expect(await cap(token, 19.9, "קפה גן")).toEqual({ ok: true, duplicate: true });
    expect((await db.sql(`select count(*)::int n from public.transactions where merchant = 'קפה גן'`))[0].n).toBe(1);
  });

  it("quick add: cash by default, saved at once, counted immediately", async () => {
    const r = await cap(token, 30, "", { kind: "quick", category: "אוכל בחוץ ומשלוחים", known: true });
    expect(r.status).toBe("saved");
    expect((await db.sql(`select t.match_status, m.type from public.transactions t join public.payment_methods m on m.id = t.payment_method_id where t.id = $1`, [r.id]))[0])
      .toEqual({ match_status: "none", type: "cash" });
  });

  it("a member who became a viewer (or left) can't add with an old token; bad amounts are refused", async () => {
    await db.sql(`update public.household_members set role = 'viewer' where household_id = $1 and user_id = $2`, [H.A, U.memberA]);
    expect(await cap(token, 5, "x")).toEqual({ ok: false, reason: "not_allowed" });
    await db.sql(`update public.household_members set role = 'member' where household_id = $1 and user_id = $2`, [H.A, U.memberA]);
    expect(await cap(token, 0, "x")).toEqual({ ok: false, reason: "invalid" });
    expect(await cap(token, 5, "x", { kind: "other" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("a wallet row is merged by the statement import (no double count)", async () => {
    const r = await cap(token, 88, "חנות הספרים", { card: "4321" });
    await db.sql(`update public.transactions set status = 'saved' where id = $1`, [r.id]);
    const res = (await db.as(as.memberA, `select public.apply_statement($1, $2, '[]'::jsonb, $3::jsonb, '{}') as r`,
      [H.A, card, JSON.stringify([{ id: r.id, date: "2026-10-21", month: "2026-10", amount: 88 }])])).rows[0].r;
    expect(res).toMatchObject({ inserted: 0, merged: 1 });
    expect((await db.sql(`select match_status from public.transactions where id = $1`, [r.id]))[0].match_status).toBe("matched");
  });

  it("capture log: members of the household see the last entries, others nothing", async () => {
    const log = (await db.as(as.viewerA, `select * from public.capture_log($1)`, [H.A])).rows;
    expect(log.length).toBeGreaterThan(3);
    expect(log.some((l) => l.source === "wallet")).toBe(true);
    expect((await db.as(as.ownerB, `select * from public.capture_log($1)`, [H.A])).rows).toHaveLength(0);
  });
});
