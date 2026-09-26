// RLS proofs: household A can never read or write household B, viewers can
// never write, and everything that is not explicitly allowed is denied.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, P, seed, TestDb, U } from "./harness";
import { NAMES } from "../fixtures/synthetic.ts";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});

afterAll(async () => {
  await db?.close();
});

const HOUSEHOLD_TABLES = [
  "people", "transactions", "fixed_expenses", "shopping_items", "analyses",
  "receipt_jobs", "usage_ledger", "household_settings", "household_members",
] as const;

describe("reading: a family sees only its own household", () => {
  for (const table of HOUSEHOLD_TABLES) {
    it(`${table}: owner A sees A rows and never B rows`, async () => {
      const { rows } = await db.as(as.ownerA, `select household_id from public.${table}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.household_id === H.A)).toBe(true);
    });
    it(`${table}: owner B never sees A rows`, async () => {
      const { rows } = await db.as(as.ownerB, `select household_id from public.${table}`);
      expect(rows.every((r) => r.household_id === H.B)).toBe(true);
    });
    it(`${table}: an outsider with no household sees nothing`, async () => {
      const { rows } = await db.as(as.outsider, `select * from public.${table}`);
      expect(rows).toHaveLength(0);
    });
    it(`${table}: anonymous callers are refused`, async () => {
      expect(await db.fails(as.anon, `select * from public.${table}`)).toMatch(/permission denied/);
    });
  }

  it("households: each owner sees exactly one household", async () => {
    expect((await db.as(as.ownerA, "select id from public.households")).rows).toEqual([{ id: H.A }]);
    expect((await db.as(as.ownerB, "select id from public.households")).rows).toEqual([{ id: H.B }]);
  });

  it("invites are visible to owners only", async () => {
    expect((await db.as(as.ownerA, "select household_id from public.invites")).rows.every((r) => r.household_id === H.A)).toBe(true);
    expect((await db.as(as.memberA, "select * from public.invites")).rows).toHaveLength(0);
    expect((await db.as(as.viewerA, "select * from public.invites")).rows).toHaveLength(0);
  });

  it("profiles: only yourself and people in your households", async () => {
    await db.sql(`insert into public.profiles (user_id, display_name) values
      ('${U.ownerA}', '${NAMES.a1}'), ('${U.ownerB}', '${NAMES.b1}') on conflict do nothing`);
    const { rows } = await db.as(as.memberA, "select user_id from public.profiles");
    expect(rows.map((r) => r.user_id)).toContain(U.ownerA);
    expect(rows.map((r) => r.user_id)).not.toContain(U.ownerB);
  });

  it("internal tables are closed to every app user", async () => {
    for (const t of ["app_admins", "app_config", "rate_limits"]) {
      expect(await db.fails(as.ownerA, `select * from public.${t}`)).toMatch(/permission denied/);
      expect(await db.fails(as.admin, `select * from public.${t}`)).toMatch(/permission denied/);
    }
  });
});

describe("writing across households is impossible", () => {
  it("cannot insert a transaction into household B", async () => {
    const err = await db.fails(as.ownerA,
      `insert into public.transactions (household_id, date, month, merchant, amount, category)
       values ($1, '2026-08-10', '2026-08', 'x', 1, 'שונות')`, [H.B]);
    expect(err).toMatch(/row-level security/);
  });

  it("cannot insert fixed expenses, shopping items, people or analyses into B", async () => {
    expect(await db.fails(as.ownerA, `insert into public.fixed_expenses (household_id, name, amount, keyword, category) values ($1,'x',1,'x','x')`, [H.B])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerA, `insert into public.shopping_items (household_id, name) values ($1,'x')`, [H.B])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerA, `insert into public.people (household_id, name) values ($1,'x')`, [H.B])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerA, `insert into public.analyses (household_id, month, data) values ($1,'2026-01','{}')`, [H.B])).toMatch(/row-level security/);
  });

  it("updates and deletes aimed at B touch zero rows", async () => {
    for (const t of ["transactions", "fixed_expenses", "shopping_items", "analyses"]) {
      const set = t === "transactions" ? "amount = 1" : t === "fixed_expenses" ? "amount = 1" : t === "shopping_items" ? "qty = 5" : "model = 'x'";
      expect((await db.as(as.ownerA, `update public.${t} set ${set} where household_id = $1`, [H.B])).affected).toBe(0);
      expect((await db.as(as.ownerA, `delete from public.${t} where household_id = $1`, [H.B])).affected).toBe(0);
    }
    const left = await db.sql(`select count(*)::int n from public.transactions where household_id = $1`, [H.B]);
    expect(left[0].n).toBe(1);
  });

  it("cannot move a row into another household", async () => {
    expect(await db.fails(as.ownerA, `update public.transactions set household_id = $1`, [H.B])).toMatch(/permission denied/);
  });

  it("cannot reference a person of another household", async () => {
    const err = await db.fails(as.ownerA,
      `insert into public.transactions (household_id, date, month, merchant, amount, category, person_id)
       values ($1, '2026-08-10', '2026-08', 'x', 1, 'שונות', $2)`, [H.A, P.b1]);
    expect(err).toMatch(/foreign key/);
  });

  it("cannot rename, settle settings of, or delete household B", async () => {
    expect((await db.as(as.ownerA, `update public.households set name = 'x' where id = $1`, [H.B])).affected).toBe(0);
    expect((await db.as(as.ownerA, `update public.household_settings set theme = 'cal' where household_id = $1`, [H.B])).affected).toBe(0);
    expect(await db.fails(as.ownerA, `select public.delete_household($1)`, [H.B])).toMatch(/not_owner/);
    expect(await db.fails(as.ownerA, `select public.create_invite($1)`, [H.B])).toMatch(/not_owner/);
  });

  it("cannot forge created_by", async () => {
    const err = await db.fails(as.ownerA,
      `insert into public.transactions (household_id, date, month, merchant, amount, category, created_by)
       values ($1, '2026-08-10', '2026-08', 'x', 1, 'שונות', $2)`, [H.A, U.memberA]);
    expect(err).toMatch(/row-level security/);
  });
});

describe("viewers cannot write", () => {
  it("insert is refused", async () => {
    expect(await db.fails(as.viewerA,
      `insert into public.transactions (household_id, date, month, merchant, amount, category)
       values ($1, '2026-08-10', '2026-08', 'x', 1, 'שונות')`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.viewerA, `insert into public.shopping_items (household_id, name) values ($1, 'x')`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.viewerA, `insert into public.people (household_id, name) values ($1, 'x')`, [H.A])).toMatch(/row-level security/);
  });

  it("update and delete change nothing", async () => {
    for (const t of ["transactions", "fixed_expenses", "shopping_items", "people"]) {
      const set = t === "people" ? "name = 'x'" : t === "shopping_items" ? "qty = 9" : "amount = 1";
      expect((await db.as(as.viewerA, `update public.${t} set ${set} where household_id = $1`, [H.A])).affected).toBe(0);
      expect((await db.as(as.viewerA, `delete from public.${t} where household_id = $1`, [H.A])).affected).toBe(0);
    }
    expect((await db.as(as.viewerA, `update public.household_settings set theme = 'cal' where household_id = $1`, [H.A])).affected).toBe(0);
  });

  it("viewers can still read", async () => {
    expect((await db.as(as.viewerA, "select * from public.transactions")).rows.length).toBeGreaterThan(0);
  });
});

describe("members and owners", () => {
  it("a member can add and edit transactions in their household", async () => {
    const { rows } = await db.as(as.memberA,
      `insert into public.transactions (household_id, date, month, merchant, amount, category, person_id)
       values ($1, '2026-08-11', '2026-08', 'קפה', 18, 'אוכל בחוץ ומשלוחים', $2) returning id, created_by`, [H.A, P.a2]);
    expect(rows[0].created_by).toBe(U.memberA);
    expect((await db.as(as.memberA, `update public.transactions set category = 'שונות' where id = $1`, [rows[0].id])).affected).toBe(1);
  });

  it("members cannot invite, rename the household or change quotas", async () => {
    expect(await db.fails(as.memberA, `select public.create_invite($1)`, [H.A])).toMatch(/not_owner/);
    expect((await db.as(as.memberA, `update public.households set name = 'x' where id = $1`, [H.A])).affected).toBe(0);
    expect(await db.fails(as.memberA, `update public.household_settings set quota_images = 9999`)).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `update public.household_settings set quota_usd = 9999`)).toMatch(/permission denied/);
  });

  it("members may change theme and send mode", async () => {
    expect((await db.as(as.memberA, `update public.household_settings set theme = 'cal', send_mode = 'monthly' where household_id = $1`, [H.A])).affected).toBe(1);
  });

  it("owners rename the household", async () => {
    expect((await db.as(as.ownerA, `update public.households set name = 'הבית שלנו' where id = $1`, [H.A])).affected).toBe(1);
  });

  it("people with a login cannot be deleted directly", async () => {
    expect((await db.as(as.ownerA, `delete from public.people where id = $1`, [P.a2])).affected).toBe(0);
  });

  it("nobody can write receipt jobs or usage directly", async () => {
    expect(await db.fails(as.ownerA, `insert into public.receipt_jobs (household_id, batch_id, model, item_count) values ($1,'x','x',1)`, [H.A])).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `insert into public.usage_ledger (household_id, kind, month) values ($1,'receipt','2026-08')`, [H.A])).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `update public.usage_ledger set usd = 0`)).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `insert into public.transactions (household_id, date, month, merchant, amount, category, receipt_job_id)
      select $1, '2026-08-10', '2026-08', 'x', 1, 'x', id from public.receipt_jobs where household_id = $1 limit 1`, [H.A])).toMatch(/row-level security/);
  });

  it("profiles cannot be edited for someone else", async () => {
    expect((await db.as(as.memberA, `update public.profiles set display_name = 'x' where user_id = $1`, [U.ownerA])).affected).toBe(0);
    expect(await db.fails(as.memberA, `insert into public.profiles (user_id, display_name) values ($1, 'x')`, [U.outsider])).toMatch(/row-level security/);
  });
});

describe("service and admin functions are locked down", () => {
  it("app users cannot call svc_* functions", async () => {
    expect(await db.fails(as.ownerA, `select public.svc_reserve_usage($1, $2, 'receipt', 1, 0.01)`, [H.A, U.ownerA])).toMatch(/permission denied/);
    expect(await db.fails(as.ownerA, `select public.svc_store_analysis($1, $2, '2026-08', '{}', 'x')`, [H.A, U.ownerA])).toMatch(/permission denied/);
    expect(await db.fails(as.anon, `select public.svc_invite_info('x')`)).toMatch(/permission denied/);
  });

  it("anonymous callers cannot call user RPCs", async () => {
    expect(await db.fails(as.anon, `select public.accept_invite('token-a-seed')`)).toMatch(/permission denied/);
  });

  it("non-admins cannot use admin RPCs", async () => {
    expect(await db.fails(as.ownerA, `select * from public.admin_overview()`)).toMatch(/not_admin/);
    expect(await db.fails(as.ownerA, `select public.admin_set_quotas($1, 1, 1, 1, 1)`, [H.A])).toMatch(/not_admin/);
    expect(await db.fails(as.ownerA, `select public.admin_create_household('x')`)).toMatch(/not_admin/);
  });

  it("the super-admin sees usage per household but no money data", async () => {
    const { rows } = await db.as(as.admin, `select * from public.admin_overview()`);
    expect(rows.map((r) => r.household_id)).toEqual(expect.arrayContaining([H.A, H.B]));
    const a = rows.find((r) => r.household_id === H.A)!;
    expect(a.images).toBe(3);
    expect(Object.keys(a)).not.toContain("amount");
    for (const t of ["transactions", "fixed_expenses", "shopping_items", "analyses", "people"]) {
      expect((await db.as(as.admin, `select * from public.${t}`)).rows).toHaveLength(0);
    }
  });

  it("the super-admin sets quotas", async () => {
    await db.as(as.admin, `select public.admin_set_quotas($1, 5, 2, 2, 1.5)`, [H.B]);
    const s = await db.sql(`select quota_images, quota_usd from public.household_settings where household_id = $1`, [H.B]);
    expect(s[0]).toEqual({ quota_images: 5, quota_usd: "1.50" });
  });

  it("an admin owner-invite is refused for a household that has members", async () => {
    expect(await db.fails(as.admin, `select public.admin_owner_invite($1)`, [H.A])).toMatch(/household_has_members/);
  });
});

describe("invites", () => {
  it("owner creates a single-use invite, the new user joins, reuse fails", async () => {
    const { rows } = await db.as(as.ownerA, `select public.create_invite($1, 'member', $2) as t`, [H.A, NAMES.grandma]);
    const token = rows[0].t as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // only the hash is stored
    expect((await db.sql(`select count(*)::int n from public.invites where token_hash = $1`, [token]))[0].n).toBe(0);

    const claim = await db.as(as.service, `select public.svc_claim_invite($1, 'NEWBIE@example.test') as r`, [token]);
    expect(claim.rows[0].r.ok).toBe(true);

    const joined = await db.as(as.newbie, `select public.accept_invite($1, null) as h`, [token]);
    expect(joined.rows[0].h).toBe(H.A);
    const role = await db.sql(`select role from public.household_members where household_id = $1 and user_id = $2`, [H.A, U.newbie]);
    expect(role[0].role).toBe("member");
    const person = await db.sql(`select name from public.people where household_id = $1 and user_id = $2`, [H.A, U.newbie]);
    expect(person[0].name).toBe(NAMES.grandma);

    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [token])).toMatch(/invite_used/);
    // newbie now sees A's data, still nothing of B
    const tx = (await db.as(as.newbie, `select household_id from public.transactions`)).rows;
    expect(tx.length).toBeGreaterThan(0);
    expect(tx.every((r) => r.household_id === H.A)).toBe(true);
  });

  it("an invite claimed by one e-mail cannot be used by another account", async () => {
    const token = (await db.as(as.ownerB, `select public.create_invite($1) as t`, [H.B])).rows[0].t;
    await db.as(as.service, `select public.svc_claim_invite($1, 'someone@example.test')`, [token]);
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [token])).toMatch(/invite_other_email/);
    const second = await db.as(as.service, `select public.svc_claim_invite($1, 'outsider@example.test') as r`, [token]);
    expect(second.rows[0].r).toEqual({ ok: false, reason: "claimed" });
  });

  it("expired and revoked invites are refused", async () => {
    const t1 = (await db.as(as.ownerB, `select public.create_invite($1) as t`, [H.B])).rows[0].t;
    await db.sql(`update public.invites set expires_at = now() - interval '1 minute' where token_hash = public.token_hash($1)`, [t1]);
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t1])).toMatch(/invite_invalid/);

    const t2 = (await db.as(as.ownerB, `select public.create_invite($1) as t`, [H.B])).rows[0].t;
    const id = (await db.sql(`select id from public.invites where token_hash = public.token_hash($1)`, [t2]))[0].id;
    await db.as(as.ownerB, `select public.revoke_invite($1)`, [id]);
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t2])).toMatch(/invite_invalid/);
  });
});

describe("membership management", () => {
  it("only owners remove members; the last owner cannot leave", async () => {
    expect(await db.fails(as.memberA, `select public.remove_member($1, $2)`, [H.A, U.viewerA])).toMatch(/not_owner/);
    expect(await db.fails(as.ownerA, `select public.remove_member($1, $2)`, [H.A, U.ownerA])).toMatch(/last_owner/);
    expect(await db.fails(as.ownerA, `select public.set_member_role($1, $2, 'member')`, [H.A, U.ownerA])).toMatch(/last_owner/);
  });

  it("a removed member loses access immediately", async () => {
    await db.as(as.ownerA, `select public.remove_member($1, $2)`, [H.A, U.newbie]);
    expect((await db.as(as.newbie, `select * from public.transactions`)).rows).toHaveLength(0);
  });
});

describe("quotas are enforced before any AI call", () => {
  it("image quota", async () => {
    await db.as(as.admin, `select public.admin_set_quotas($1, 4, 1, 1, 10)`, [H.A]);
    const ok = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 1, 0.002) as r`, [H.A, U.ownerA])).rows[0].r;
    expect(ok.ok).toBe(true); // 3 used + 1 = 4
    const no = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 1, 0.002) as r`, [H.A, U.ownerA])).rows[0].r;
    expect(no).toMatchObject({ ok: false, reason: "quota_receipt" });
    // releasing a reservation frees the quota
    await db.as(as.service, `select public.svc_release_usage($1)`, [ok.reservation_id]);
    const again = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 1, 0.002) as r`, [H.A, U.ownerA])).rows[0].r;
    expect(again.ok).toBe(true);
  });

  it("USD quota and the global cap", async () => {
    await db.as(as.admin, `select public.admin_set_quotas($1, 100, 10, 10, 0.10)`, [H.A]);
    const no = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'statement', 1, 0.2) as r`, [H.A, U.ownerA])).rows[0].r;
    expect(no.reason).toBe("quota_usd");
    await db.as(as.admin, `select public.admin_set_quotas($1, 100, 10, 10, 100)`, [H.A]);
    await db.as(as.admin, `select public.admin_set_global_cap(0.05)`);
    const cap = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'statement', 1, 0.2) as r`, [H.A, U.ownerA])).rows[0].r;
    expect(cap.reason).toBe("global_cap");
    await db.as(as.admin, `select public.admin_set_global_cap(30)`);
  });
});

describe("receipt batch completion", () => {
  it("creates review transactions once, drops foreign person ids", async () => {
    const res = (await db.as(as.service, `select public.svc_reserve_usage($1, $2, 'receipt', 2, 0.004) as r`, [H.A, U.memberA])).rows[0].r;
    const job = (await db.as(as.service,
      `select public.svc_record_receipt_job($1, $2, 'msgbatch_x', 'claude-haiku-4-5', $3::jsonb, $4) as id`,
      [H.A, U.memberA, JSON.stringify([{ client_id: "c1", person_id: P.a2 }, { client_id: "c2", person_id: P.b1 }]), res.reservation_id])).rows[0].id;
    const items = (await db.sql(`select items from public.receipt_jobs where id = $1`, [job]))[0].items;
    expect(items[1].person_id).toBeNull(); // B's person was dropped

    const results = JSON.stringify([
      { client_id: "c1", ok: true, receipt: { merchant: "סופר השכונה", date: "2026-08-20", total: 87.5, category: "סופר ומכולת", note: "", items: [] } },
      { client_id: "c2", ok: false, reason: "unreadable" },
    ]);
    const out = (await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 1000, 200, 0.001) as r`, [job, results])).rows[0].r;
    expect(out).toMatchObject({ ok: true, parsed: 1, failed: 1 });
    const again = (await db.as(as.service, `select public.svc_complete_receipt_job($1, $2::jsonb, 1000, 200, 0.001) as r`, [job, results])).rows[0].r;
    expect(again.ok).toBe(false);

    const tx = await db.sql(`select status, person_id, amount, created_by from public.transactions where receipt_job_id = $1`, [job]);
    expect(tx).toEqual([{ status: "review", person_id: P.a2, amount: "87.50", created_by: U.memberA }]);
    const led = await db.sql(`select status, usd from public.usage_ledger where id = $1`, [res.reservation_id]);
    expect(led[0]).toEqual({ status: "final", usd: "0.00100" });

    // B cannot see A's receipt job or its transactions
    expect((await db.as(as.ownerB, `select * from public.receipt_jobs where id = $1`, [job])).rows).toHaveLength(0);
  });
});

describe("deleting data", () => {
  it("account deletion is refused while you are the last owner of a shared household", async () => {
    const r = (await db.as(as.service, `select public.svc_prepare_account_deletion($1) as r`, [U.ownerA])).rows[0].r;
    expect(r.ok).toBe(false);
    expect(r.blocked.length).toBe(1);
  });

  it("a member cannot delete the household; the owner can, and all data goes", async () => {
    expect(await db.fails(as.memberA, `select public.delete_household($1)`, [H.A])).toMatch(/not_owner/);
    await db.as(as.ownerB, `select public.delete_household($1)`, [H.B]);
    for (const t of ["transactions", "fixed_expenses", "shopping_items", "people", "analyses", "receipt_jobs", "invites"]) {
      const n = await db.sql(`select count(*)::int n from public.${t} where household_id = $1`, [H.B]);
      expect(n[0].n).toBe(0);
    }
    // usage history stays for the global cap, detached from the household
    const led = await db.sql(`select count(*)::int n from public.usage_ledger where household_id is null`);
    expect(led[0].n).toBeGreaterThan(0);
  });

  it("a sole-member household is deleted with the account", async () => {
    await db.sql(`insert into public.households (id, name) values ('00000000-0000-4000-8000-0000000000cc', 'לבד')`);
    await db.sql(`insert into public.household_members values ('00000000-0000-4000-8000-0000000000cc', $1, 'owner')`, [U.outsider]);
    const r = (await db.as(as.service, `select public.svc_prepare_account_deletion($1) as r`, [U.outsider])).rows[0].r;
    expect(r.ok).toBe(true);
    expect((await db.sql(`select count(*)::int n from public.households where id = '00000000-0000-4000-8000-0000000000cc'`))[0].n).toBe(0);
  });
});

describe("two-factor (aal1 vs aal2) is enforced by the database", () => {
  const FIN = ["transactions", "fixed_expenses", "shopping_items", "people", "analyses", "receipt_jobs", "usage_ledger"];

  it("an owner without a second factor (aal1) sees no financial data and cannot write", async () => {
    for (const t of FIN) {
      expect((await db.as(as.ownerA1, `select * from public.${t}`)).rows).toHaveLength(0);
    }
    expect(await db.fails(as.ownerA1,
      `insert into public.transactions (household_id, date, month, merchant, amount, category)
       values ($1, '2026-08-12', '2026-08', 'x', 1, 'שונות')`, [H.A])).toMatch(/row-level security/);
    expect(await db.fails(as.ownerA1, `select public.create_invite($1)`, [H.A])).toMatch(/not_owner/);
    expect((await db.as(as.ownerA1, `update public.households set name = 'x' where id = $1`, [H.A])).affected).toBe(0);
  });

  it("the same owner at aal2 has full access", async () => {
    expect((await db.as(as.ownerA, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
  });

  it("at aal1 the owner still sees the household list and roster (to be told a code is needed)", async () => {
    expect((await db.as(as.ownerA1, `select id from public.households`)).rows).toEqual([{ id: H.A }]);
    expect((await db.as(as.ownerA1, `select role from public.household_members where user_id = $1`, [U.ownerA])).rows[0].role).toBe("owner");
  });

  it("a member without a factor may use aal1 when the household does not require it", async () => {
    expect((await db.as(as.memberA, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
  });

  it("once a member enrolls a factor, aal1 is no longer enough", async () => {
    await db.sql(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
                  values (gen_random_uuid(), $1, 'test', 'totp', 'verified', now(), now())`, [U.memberA]);
    expect((await db.as(as.memberA, `select * from public.transactions`)).rows).toHaveLength(0);
    expect((await db.as(as.memberA2, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
    // an unverified (half-finished) enrollment does not lock anyone out
    await db.sql(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
                  values (gen_random_uuid(), $1, 'test2', 'totp', 'unverified', now(), now())`, [U.viewerA]);
    expect((await db.as(as.viewerA, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
  });

  it("when the owner requires MFA for the household, members need aal2 too", async () => {
    expect(await db.fails(as.memberA2, `select public.set_require_mfa($1, true)`, [H.A])).toMatch(/not_owner/);
    expect(await db.fails(as.memberA2, `update public.household_settings set require_mfa = true`)).toMatch(/permission denied/);
    await db.as(as.ownerA, `select public.set_require_mfa($1, true)`, [H.A]);
    expect((await db.as(as.viewerA, `select * from public.transactions`)).rows).toHaveLength(0);
    expect((await db.as(as.viewerA2, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
    expect(await db.fails(as.viewerA, `select public.household_usage($1)`, [H.A])).toMatch(/not_member/);
    await db.as(as.ownerA, `select public.set_require_mfa($1, false)`, [H.A]);
    expect((await db.as(as.viewerA, `select * from public.transactions`)).rows.length).toBeGreaterThan(0);
  });

  it("the super-admin needs aal2 for every admin function", async () => {
    expect(await db.fails(as.admin1, `select * from public.admin_overview()`)).toMatch(/not_admin/);
    expect(await db.fails(as.admin1, `select public.admin_set_global_cap(1)`)).toMatch(/not_admin/);
    expect((await db.as(as.admin, `select * from public.admin_overview()`)).rows.length).toBeGreaterThan(0);
  });

  it("Edge Functions get the same answer through svc_access", async () => {
    const r1 = (await db.as(as.service, `select public.svc_access($1, $2, 'aal1') as r`, [H.A, U.ownerA])).rows[0].r;
    expect(r1).toEqual({ role: "owner", mfa_required: true, mfa_ok: false });
    const r2 = (await db.as(as.service, `select public.svc_access($1, $2, 'aal2') as r`, [H.A, U.ownerA])).rows[0].r;
    expect(r2.mfa_ok).toBe(true);
    const r3 = (await db.as(as.service, `select public.svc_access($1, $2, 'aal1') as r`, [H.A, U.outsider])).rows[0].r;
    expect(r3.role).toBeNull();
    expect(await db.fails(as.ownerA, `select public.svc_access($1, $2, 'aal2')`, [H.A, U.ownerA])).toMatch(/permission denied/);
  });

  it("recovery codes: generated only at aal2, stored hashed, single use", async () => {
    expect(await db.fails(as.memberA, `select public.generate_recovery_codes()`)).toMatch(/aal2_required/);
    const codes = (await db.as(as.memberA2, `select public.generate_recovery_codes() as c`)).rows[0].c as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    const stored = await db.sql(`select code_hash from public.mfa_recovery_codes where user_id = $1`, [U.memberA]);
    expect(stored).toHaveLength(10);
    expect(stored.some((r) => r.code_hash.includes(codes[0].replace("-", "")))).toBe(false);
    expect(await db.fails(as.memberA2, `select * from public.mfa_recovery_codes`)).toMatch(/permission denied/);

    const use = (code: string) => db.as(as.service, `select public.svc_use_recovery_code($1, $2) as ok`, [U.memberA, code]);
    expect((await use(codes[3].toLowerCase().replace("-", " "))).rows[0].ok).toBe(true); // case/format tolerant
    expect((await use(codes[3])).rows[0].ok).toBe(false);                               // single use
    expect((await use("AAAAA-BBBBB")).rows[0].ok).toBe(false);
    expect((await db.as(as.memberA, `select public.recovery_codes_status() as s`)).rows[0].s).toEqual({ total: 10, remaining: 9 });
    expect(await db.fails(as.memberA2, `select public.svc_use_recovery_code($1, $2)`, [U.memberA, codes[0]])).toMatch(/permission denied/);
  });

  it("an owner may reset MFA only for non-owner members of their own household", async () => {
    const can = async (hh: string, caller: string, target: string) =>
      (await db.as(as.service, `select public.svc_can_reset_mfa($1, $2, $3) as ok`, [hh, caller, target])).rows[0].ok;
    expect(await can(H.A, U.ownerA, U.memberA)).toBe(true);
    expect(await can(H.A, U.memberA, U.viewerA)).toBe(false);   // not an owner
    expect(await can(H.A, U.ownerA, U.ownerA)).toBe(false);     // not yourself
    expect(await can(H.A, U.ownerA, U.ownerB)).toBe(false);     // not in the household
  });
});
