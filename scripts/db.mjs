// Database helper for the live Supabase project, using the DB password from
// .env.local. Connects through the IPv4 session pooler.
//
//   node scripts/db.mjs probe            find the pooler host (region) and save it
//   node scripts/db.mjs status           list applied migrations
//   node scripts/db.mjs migrate          apply supabase/migrations/*.sql not yet applied
//   node scripts/db.mjs sql <file.sql>   run one SQL file (e.g. supabase/remote/*.sql)
//
// Never prints secret values.
import pg from "pg";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, need, projectRef, redact } from "./lib/env.mjs";

const env = loadEnv();
need(env, "SUPABASE_URL", "SUPABASE_DB_PASSWORD");
const ref = projectRef(env);
const HOST_CACHE = join(process.cwd(), "supabase", ".temp", "pooler-host");

const REGIONS = [
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-south-1",
];

function clientFor(host) {
  return new pg.Client({
    host, port: 5432, database: "postgres",
    user: `postgres.${ref}`, password: env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
    application_name: "household-budget-setup",
  });
}

async function tryHost(host) {
  const c = clientFor(host);
  try {
    await c.connect();
    await c.query("select 1");
    await c.end();
    return { ok: true };
  } catch (e) {
    try { await c.end(); } catch { /* ignore */ }
    return { ok: false, msg: redact(env, e.message) };
  }
}

async function probe() {
  if (env.SUPABASE_DB_HOST) return env.SUPABASE_DB_HOST;
  if (existsSync(HOST_CACHE)) return readFileSync(HOST_CACHE, "utf8").trim();
  for (const prefix of ["aws-0", "aws-1"]) {
    for (const region of REGIONS) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const r = await tryHost(host);
      if (r.ok) {
        writeFileSync(HOST_CACHE, host);
        console.log(`pooler: ${prefix}-${region}`);
        return host;
      }
      if (!/tenant|not found|ENOTFOUND/i.test(r.msg)) console.log(`${prefix}-${region}: ${r.msg}`);
    }
  }
  throw new Error("Could not reach the database through any pooler region.");
}

async function connect() {
  const host = await probe();
  const c = clientFor(host);
  await c.connect();
  return c;
}

async function ensureTable(c) {
  await c.query(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key, statements text[], name text)`);
}

async function applied(c) {
  await ensureTable(c);
  const r = await c.query("select version, name from supabase_migrations.schema_migrations order by version");
  return r.rows;
}

async function migrate() {
  const c = await connect();
  try {
    const done = new Set((await applied(c)).map((r) => r.version));
    const dir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const version = f.split("_")[0];
      if (done.has(version)) continue;
      const body = readFileSync(join(dir, f), "utf8");
      await c.query("begin");
      try {
        await c.query(body);
        await c.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
          [version, f.replace(/^\d+_|\.sql$/g, ""), [body]]);
        await c.query("commit");
        console.log(`applied ${f}`);
      } catch (e) {
        await c.query("rollback");
        throw new Error(`${f}: ${redact(env, e.message)}`);
      }
    }
    console.log("migrations up to date");
  } finally {
    await c.end();
  }
}

async function runFile(file) {
  const c = await connect();
  try {
    await c.query(readFileSync(file, "utf8"));
    console.log(`ran ${file}`);
  } finally {
    await c.end();
  }
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "probe") { await probe(); console.log("database reachable"); }
  else if (cmd === "status") { const c = await connect(); console.table(await applied(c)); await c.end(); }
  else if (cmd === "migrate") await migrate();
  else if (cmd === "sql" && arg) await runFile(arg);
  else { console.log("usage: node scripts/db.mjs probe|status|migrate|sql <file>"); process.exit(1); }
} catch (e) {
  console.error(redact(env, e.message));
  process.exit(1);
}
