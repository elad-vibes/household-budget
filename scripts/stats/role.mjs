// Gives the `hb_stats` role (migration 0012) a login + password on the live
// project, and saves the password to .env.local as STATS_DB_PASSWORD.
//
//   node scripts/stats/role.mjs            first time (keeps an existing password)
//   node scripts/stats/role.mjs --rotate   new password (then re-run the server install)
//
// The password is sent to Postgres already hashed (SCRAM verifier). Never printed.
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, need, projectRef, redact } from "../lib/env.mjs";
import { scramVerifier } from "../lib/scram.mjs";

const ENV_FILE = join(process.cwd(), ".env.local");
const env = loadEnv();
need(env, "SUPABASE_URL", "SUPABASE_DB_PASSWORD");
const ref = projectRef(env);
const rotate = process.argv.includes("--rotate");

function saveLocal(key, value) {
  const lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => !l.startsWith(`${key}=`));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(ENV_FILE, `${lines.join("\n")}\n${key}=${value}\n`);
}

async function main() {
  const host = env.SUPABASE_DB_HOST || readFileSync(join(process.cwd(), "supabase", ".temp", "pooler-host"), "utf8").trim();
  const admin = new pg.Client({ host, port: 5432, database: "postgres", user: `postgres.${ref}`,
    password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  try {
    const role = (await admin.query("select rolcanlogin from pg_roles where rolname = 'hb_stats'")).rows[0];
    if (!role) throw new Error("role hb_stats not found — run `node scripts/db.mjs migrate` first (0012)");
    if (!env.STATS_DB_PASSWORD || rotate || !role.rolcanlogin) {
      const password = randomBytes(24).toString("base64url");
      // a SCRAM verifier contains only [A-Za-z0-9+/=$:-], safe inside a literal
      await admin.query(`alter role hb_stats with login noinherit connection limit 3 password '${scramVerifier(password)}'`);
      await admin.query("alter role hb_stats set statement_timeout = '15s'");
      saveLocal("STATS_DB_PASSWORD", password);
      console.log("hb_stats: new password set and saved to .env.local (STATS_DB_PASSWORD)");
    } else {
      console.log("hb_stats: already has a login; keeping the saved password (use --rotate for a new one)");
    }
  } finally {
    await admin.end();
  }

  // prove it: sign in AS hb_stats through the pooler, call the snapshot, try a table
  const c = new pg.Client({ host, port: 5432, database: "postgres", user: `hb_stats.${ref}`,
    password: loadEnv().STATS_DB_PASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await c.connect();
  try {
    const s = (await c.query("select public.stats_snapshot() as s")).rows[0].s;
    let denied = false;
    try { await c.query("select 1 from public.transactions limit 1"); } catch { denied = true; }
    console.log(`hb_stats sign-in ok · month ${s.month} · ${s.households.total} households · tables closed: ${denied ? "yes" : "NO!"}`);
    if (!denied) process.exitCode = 3;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(redact(loadEnv(), e.message));
  process.exit(1);
});
