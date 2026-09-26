// Test harness: a real Postgres (PGlite, WASM — no Docker) with a small shim
// of Supabase's auth schema and roles, then our migrations applied in order.
// Queries run as `authenticated` with JWT claims, exactly as PostgREST does.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges: everything in public is granted to the API roles;
-- RLS (and our explicit revokes) are what actually protect the data.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export type Row = Record<string, any>;
export type Actor = { role: "anon" | "authenticated" | "service_role"; uid?: string };

export class TestDb {
  constructor(public pg: PGlite) {}

  /** Runs SQL as superuser (setup / verification). */
  async sql(query: string, params: unknown[] = []): Promise<Row[]> {
    if (!params.length) {
      const results = await this.pg.exec(query);
      return (results[results.length - 1]?.rows ?? []) as Row[];
    }
    return (await this.pg.query<Row>(query, params)).rows;
  }

  /** Runs one statement as the given actor inside a transaction. Throws on error. */
  async as(actor: Actor, query: string, params: unknown[] = []): Promise<{ rows: Row[]; affected: number }> {
    const claims = JSON.stringify({ sub: actor.uid ?? null, role: actor.role });
    await this.pg.exec("begin");
    try {
      await this.pg.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await this.pg.exec(`set local role ${actor.role}`);
      const res = await this.pg.query<Row>(query, params);
      await this.pg.exec("commit");
      return { rows: res.rows, affected: res.affectedRows ?? 0 };
    } catch (e) {
      await this.pg.exec("rollback");
      throw e;
    }
  }

  /** Same as `as` but returns the error message instead of throwing (null = success). */
  async fails(actor: Actor, query: string, params: unknown[] = []): Promise<string | null> {
    try {
      await this.as(actor, query, params);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_SHIM);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return new TestDb(pg);
}

// Deterministic synthetic ids
export const U = {
  ownerA: "00000000-0000-4000-8000-00000000a001",
  memberA: "00000000-0000-4000-8000-00000000a002",
  viewerA: "00000000-0000-4000-8000-00000000a003",
  ownerB: "00000000-0000-4000-8000-00000000b001",
  outsider: "00000000-0000-4000-8000-00000000c001",
  admin: "00000000-0000-4000-8000-00000000d001",
  newbie: "00000000-0000-4000-8000-00000000e001",
};
export const H = {
  A: "00000000-0000-4000-8000-0000000000aa",
  B: "00000000-0000-4000-8000-0000000000bb",
};
export const P = {
  a1: "00000000-0000-4000-8000-0000000a0001",
  a2: "00000000-0000-4000-8000-0000000a0002",
  kidA: "00000000-0000-4000-8000-0000000a0003",
  b1: "00000000-0000-4000-8000-0000000b0001",
};

export const as = {
  ownerA: { role: "authenticated", uid: U.ownerA } as Actor,
  memberA: { role: "authenticated", uid: U.memberA } as Actor,
  viewerA: { role: "authenticated", uid: U.viewerA } as Actor,
  ownerB: { role: "authenticated", uid: U.ownerB } as Actor,
  outsider: { role: "authenticated", uid: U.outsider } as Actor,
  admin: { role: "authenticated", uid: U.admin } as Actor,
  newbie: { role: "authenticated", uid: U.newbie } as Actor,
  anon: { role: "anon" } as Actor,
  service: { role: "service_role" } as Actor,
};

/** Two households with members, people and a bit of data each. */
export async function seed(db: TestDb) {
  await db.sql(`
    insert into auth.users (id, email) values
      ('${U.ownerA}', 'owner.a@example.test'), ('${U.memberA}', 'member.a@example.test'),
      ('${U.viewerA}', 'viewer.a@example.test'), ('${U.ownerB}', 'owner.b@example.test'),
      ('${U.outsider}', 'outsider@example.test'), ('${U.admin}', 'admin@example.test'),
      ('${U.newbie}', 'newbie@example.test');
    insert into public.app_admins (user_id) values ('${U.admin}');
    insert into public.households (id, name) values ('${H.A}', 'בית א'), ('${H.B}', 'בית ב');
    insert into public.household_members (household_id, user_id, role) values
      ('${H.A}', '${U.ownerA}', 'owner'), ('${H.A}', '${U.memberA}', 'member'),
      ('${H.A}', '${U.viewerA}', 'viewer'), ('${H.B}', '${U.ownerB}', 'owner');
    insert into public.people (id, household_id, name, user_id) values
      ('${P.a1}', '${H.A}', 'דנה', '${U.ownerA}'), ('${P.a2}', '${H.A}', 'יואב', '${U.memberA}'),
      ('${P.kidA}', '${H.A}', 'נועה', null), ('${P.b1}', '${H.B}', 'רון', '${U.ownerB}');
    insert into public.transactions (household_id, date, month, merchant, amount, category, person_id, created_by) values
      ('${H.A}', '2026-08-03', '2026-08', 'שופרסל דיל', 312.40, 'סופר ומכולת', '${P.a1}', '${U.ownerA}'),
      ('${H.A}', '2026-08-05', '2026-08', 'חברת החשמל', 420.00, 'חשבונות בית', null, '${U.ownerA}'),
      ('${H.B}', '2026-08-04', '2026-08', 'רמי לוי', 199.90, 'סופר ומכולת', '${P.b1}', '${U.ownerB}');
    insert into public.fixed_expenses (household_id, name, amount, keyword, category) values
      ('${H.A}', 'ביטוח בריאות', 89, 'הראל', 'ביטוחים'), ('${H.B}', 'ארנונה', 610, 'עיריית', 'חשבונות בית');
    insert into public.shopping_items (household_id, name) values ('${H.A}', 'חלב'), ('${H.B}', 'לחם');
    insert into public.analyses (household_id, month, data) values
      ('${H.A}', '2026-08', '{"status":"א"}'), ('${H.B}', '2026-08', '{"status":"ב"}');
    insert into public.usage_ledger (household_id, kind, units, usd, status, month) values
      ('${H.A}', 'receipt', 3, 0.006, 'final', public.local_month()),
      ('${H.B}', 'statement', 1, 0.05, 'final', public.local_month());
    insert into public.receipt_jobs (household_id, batch_id, model, item_count) values
      ('${H.A}', 'msgbatch_a', 'claude-haiku-4-5', 1), ('${H.B}', 'msgbatch_b', 'claude-haiku-4-5', 1);
    insert into public.invites (household_id, token_hash, role) values
      ('${H.A}', public.token_hash('token-a-seed'), 'member'), ('${H.B}', public.token_hash('token-b-seed'), 'member');
  `);
}
