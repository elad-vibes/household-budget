// Test harness for the RLS suite.
//
// Local (default): a real Postgres (PGlite, WASM — no Docker) with a small shim of
// Supabase's auth schema and roles, then our migrations applied in order.
// Remote (RLS_TARGET=remote): the live Supabase database from .env.local. The whole
// suite runs inside ONE transaction that is rolled back at the end, so no test data
// is ever left behind.
//
// Either way, queries run as `authenticated` with JWT claims, exactly as PostgREST does.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../fixtures/synthetic.ts";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now());
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text, factor_type text not null, status text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), secret text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
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
export type Actor = { role: "anon" | "authenticated" | "service_role"; uid?: string; aal?: "aal1" | "aal2" };

interface Driver {
  query(sql: string, params: unknown[]): Promise<{ rows: Row[]; affected: number }>;
  exec(sql: string): Promise<Row[]>; // multi-statement, returns rows of the last one
  close(): Promise<void>;
  remote: boolean;
}

function pgliteDriver(pg: PGlite): Driver {
  return {
    remote: false,
    async query(sql, params) {
      const r = await pg.query<Row>(sql, params);
      return { rows: r.rows, affected: r.affectedRows ?? 0 };
    },
    async exec(sql) {
      const results = await pg.exec(sql);
      return (results[results.length - 1]?.rows ?? []) as Row[];
    },
    async close() {
      await pg.close();
    },
  };
}

async function remoteDriver(): Promise<Driver> {
  const { default: pg } = await import("pg");
  const { loadEnv, projectRef } = await import("../../scripts/lib/env.mjs");
  const env = loadEnv();
  const host = readFileSync(join(process.cwd(), "supabase", ".temp", "pooler-host"), "utf8").trim();
  const client = new pg.Client({
    host, port: 5432, database: "postgres", user: `postgres.${projectRef(env)}`,
    password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  // numeric/date columns come back as strings, like PGlite
  return {
    remote: true,
    async query(sql, params) {
      const r = await client.query(sql, params as any[]);
      return { rows: r.rows, affected: r.rowCount ?? 0 };
    },
    async exec(sql) {
      const r: any = await client.query(sql);
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return last?.rows ?? [];
    },
    async close() {
      await client.end();
    },
  };
}

export class TestDb {
  constructor(private d: Driver) {}

  /** Runs SQL as the database owner (setup / verification). */
  async sql(query: string, params: unknown[] = []): Promise<Row[]> {
    if (!params.length) return this.d.exec(query);
    return (await this.d.query(query, params)).rows;
  }

  /** Runs one statement as the given actor. Throws on error. */
  async as(actor: Actor, query: string, params: unknown[] = []): Promise<{ rows: Row[]; affected: number }> {
    const claims = JSON.stringify({ sub: actor.uid ?? null, role: actor.role, aal: actor.aal ?? "aal1" });
    const [open, ok, bad] = this.d.remote
      ? ["savepoint t", "release savepoint t", "rollback to savepoint t"]
      : ["begin", "commit", "rollback"];
    await this.d.exec(open);
    try {
      await this.d.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await this.d.exec(`set local role ${actor.role}`);
      const res = await this.d.query(query, params);
      if (this.d.remote) await this.d.exec("reset role; select set_config('request.jwt.claims', '', true)");
      await this.d.exec(ok);
      return res;
    } catch (e) {
      await this.d.exec(bad);
      if (this.d.remote) await this.d.exec("reset role");
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

  async close() {
    if (this.d.remote) await this.d.exec("rollback");
    await this.d.close();
  }
}

export async function createTestDb(): Promise<TestDb> {
  if (process.env.RLS_TARGET === "remote") {
    const d = await remoteDriver();
    await d.exec("begin");
    return new TestDb(d);
  }
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
  return new TestDb(pgliteDriver(pg));
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

// Owners and the super-admin must use two-factor (aal2); others default to aal1.
const user = (uid: string, aal: "aal1" | "aal2" = "aal1"): Actor => ({ role: "authenticated", uid, aal });
export const as = {
  ownerA: user(U.ownerA, "aal2"),
  ownerA1: user(U.ownerA, "aal1"),
  memberA: user(U.memberA),
  memberA2: user(U.memberA, "aal2"),
  viewerA: user(U.viewerA),
  viewerA2: user(U.viewerA, "aal2"),
  ownerB: user(U.ownerB, "aal2"),
  outsider: user(U.outsider),
  admin: user(U.admin, "aal2"),
  admin1: user(U.admin, "aal1"),
  newbie: user(U.newbie),
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
    insert into public.households (id, name) values ('${H.A}', '${NAMES.hhA}'), ('${H.B}', '${NAMES.hhB}');
    insert into public.household_members (household_id, user_id, role) values
      ('${H.A}', '${U.ownerA}', 'owner'), ('${H.A}', '${U.memberA}', 'member'),
      ('${H.A}', '${U.viewerA}', 'viewer'), ('${H.B}', '${U.ownerB}', 'owner');
    insert into public.people (id, household_id, name, user_id) values
      ('${P.a1}', '${H.A}', '${NAMES.a1}', '${U.ownerA}'), ('${P.a2}', '${H.A}', '${NAMES.a2}', '${U.memberA}'),
      ('${P.kidA}', '${H.A}', '${NAMES.kid}', null), ('${P.b1}', '${H.B}', '${NAMES.b1}', '${U.ownerB}');
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
