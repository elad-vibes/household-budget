// Exactly one owner per household (0007_single_owner.sql, household-roles.md):
// second owner, owner invites, promotion to owner, transfer of ownership, leaving.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb, U } from "./harness";

let db: TestDb;
const roleOf = async (u: string) =>
  (await db.sql(`select role from public.household_members where household_id = $1 and user_id = $2`, [H.A, u]))[0]?.role;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});
afterAll(async () => { await db?.close(); });

describe("one owner per household", () => {
  it("the database refuses a second owner", async () => {
    await expect(db.sql(`update public.household_members set role = 'owner' where household_id = $1 and user_id = $2`, [H.A, U.memberA]))
      .rejects.toThrow(/household_one_owner|duplicate key/);
    expect(await roleOf(U.memberA)).toBe("member");
  });

  it("an invite from inside the household cannot be an owner invite", async () => {
    expect(await db.fails(as.ownerA, `select public.create_invite($1, 'owner')`, [H.A])).toMatch(/owner_invite/);
    expect((await db.as(as.ownerA, `select public.create_invite($1, 'viewer') as t`, [H.A])).rows[0].t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an owner invite is void once the household has an owner", async () => {
    await db.sql(`insert into public.invites (household_id, token_hash, role) values ($1, public.token_hash('owner-token-x'), 'owner')`, [H.A]);
    expect(await db.fails(as.newbie, `select public.accept_invite('owner-token-x')`)).toMatch(/household_has_owner/);
    expect(await roleOf(U.newbie)).toBeUndefined();
  });

  it("nobody is promoted to owner by a role change", async () => {
    expect(await db.fails(as.ownerA, `select public.set_member_role($1, $2, 'owner')`, [H.A, U.memberA])).toMatch(/use_transfer/);
    expect(await db.fails(as.memberA2, `select public.set_member_role($1, $2, 'owner')`, [H.A, U.memberA])).toMatch(/not_owner/);
    await db.as(as.ownerA, `select public.set_member_role($1, $2, 'member')`, [H.A, U.viewerA]);
    expect(await roleOf(U.viewerA)).toBe("member");
    await db.as(as.ownerA, `select public.set_member_role($1, $2, 'viewer')`, [H.A, U.viewerA]);
  });
});

describe("transfer of ownership", () => {
  it("a member cannot transfer (not even to themselves); an owner at aal1 cannot; not to self or outsiders", async () => {
    expect(await db.fails(as.memberA2, `select public.transfer_ownership($1, $2)`, [H.A, U.memberA])).toMatch(/not_owner/);
    expect(await db.fails(as.ownerA1, `select public.transfer_ownership($1, $2)`, [H.A, U.memberA])).toMatch(/not_owner/);
    expect(await db.fails(as.ownerA, `select public.transfer_ownership($1, $2)`, [H.A, U.ownerA])).toMatch(/invalid/);
    expect(await db.fails(as.ownerA, `select public.transfer_ownership($1, $2)`, [H.A, U.outsider])).toMatch(/not_found/);
    expect(await db.fails(as.ownerB, `select public.transfer_ownership($1, $2)`, [H.A, U.memberA])).toMatch(/not_owner/);
    expect(await db.fails(as.anon, `select public.transfer_ownership($1, $2)`, [H.A, U.memberA])).toMatch(/permission denied/);
  });

  it("the owner cannot leave or delete the account while others are in the household", async () => {
    expect(await db.fails(as.ownerA, `select public.remove_member($1, $2)`, [H.A, U.ownerA])).toMatch(/last_owner/);
    const r = (await db.as(as.service, `select public.svc_prepare_account_deletion($1) as r`, [U.ownerA])).rows[0].r;
    expect(r.ok).toBe(false);
    expect(r.blocked).toHaveLength(1);
  });

  it("transfer swaps the two roles in one step; the old owner can then leave", async () => {
    await db.as(as.ownerA, `select public.transfer_ownership($1, $2)`, [H.A, U.memberA]);
    expect(await roleOf(U.ownerA)).toBe("member");
    expect(await roleOf(U.memberA)).toBe("owner");
    const owners = await db.sql(`select count(*)::int n from public.household_members where household_id = $1 and role = 'owner'`, [H.A]);
    expect(owners[0].n).toBe(1);
    // the former owner has no owner powers any more
    expect(await db.fails(as.ownerA, `select public.transfer_ownership($1, $2)`, [H.A, U.ownerA])).toMatch(/not_owner/);
    expect(await db.fails(as.ownerA, `select public.create_invite($1)`, [H.A])).toMatch(/not_owner/);
    // the new owner needs the second factor like every owner
    expect(await db.fails(as.memberA, `select public.create_invite($1)`, [H.A])).toMatch(/not_owner/);
    expect((await db.as(as.memberA2, `select public.create_invite($1) as t`, [H.A])).rows[0].t).toBeTruthy();
    await db.as(as.ownerA, `select public.remove_member($1, $2)`, [H.A, U.ownerA]);
    expect(await roleOf(U.ownerA)).toBeUndefined();
  });
});
