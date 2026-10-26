// 0010_price_compare.sql: comparison location in settings, server-only cache and RPCs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, H, seed, TestDb } from "./harness";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); await seed(db); });
afterAll(async () => { await db?.close(); });

describe("price compare (0010)", () => {
  it("members set the comparison city/street; viewers and other households can't", async () => {
    await db.as(as.memberA, `update public.household_settings set price_city = 'עיר לדוגמה', price_street = 'רחוב 1' where household_id = $1`, [H.A]);
    expect((await db.sql(`select price_city from public.household_settings where household_id = $1`, [H.A]))[0].price_city).toBe("עיר לדוגמה");
    expect((await db.as(as.viewerA, `update public.household_settings set price_city = 'x y' where household_id = $1`, [H.A])).affected).toBe(0);
    expect((await db.as(as.ownerB, `update public.household_settings set price_city = 'x y' where household_id = $1`, [H.A])).affected).toBe(0);
    expect(await db.fails(as.memberA, `update public.household_settings set price_city = 'x' where household_id = $1`, [H.A])).toMatch(/check constraint/);
  });

  it("the input RPC returns only open items + location; cache and RPCs are closed to app users", async () => {
    await db.sql(`insert into public.shopping_items (household_id, name, qty, done) values ($1, 'ביצים', 2, false), ($1, 'נקנה כבר', 1, true)`, [H.A]);
    const r = (await db.as(as.service, `select public.svc_price_compare_input($1) as r`, [H.A])).rows[0].r;
    expect(r.city).toBe("עיר לדוגמה");
    expect(r.items.map((i: any) => i.name).sort()).toEqual(["ביצים", "חלב"].sort());
    await db.as(as.service, `select public.svc_price_cache_put($1, $2, '{"stores":[]}'::jsonb)`, [H.A, "a".repeat(64)]);
    expect((await db.as(as.service, `select public.svc_price_cache_get($1, $2, 60) as r`, [H.A, "a".repeat(64)])).rows[0].r).toEqual({ stores: [] });
    expect(await db.fails(as.memberA, `select * from public.price_compare_cache`)).toMatch(/permission denied/);
    expect(await db.fails(as.memberA, `select public.svc_price_compare_input($1)`, [H.A])).toMatch(/permission denied/);
    expect(await db.fails(as.memberA, `select public.svc_price_cache_get($1, $2, 60)`, [H.A, "a".repeat(64)])).toMatch(/permission denied/);
  });
});
