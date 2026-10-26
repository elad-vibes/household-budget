// Admin dashboard collector. Runs every 5 minutes on Elad's server (crontab of
// the `vibes` user) or locally for a check:
//
//   node scripts/stats/collect.mjs                  local: .env.local → scratch/stats-out/
//   STATS_ENV_FILE=/path/.env node collect.cjs      server (bundled by `npm run stats:bundle`)
//
// Signs in to the database as `hb_stats` (can only call stats_snapshot()), asks
// GitHub's public API for the last site deploy, and writes index.html + stats.json
// atomically. On a DB failure it re-renders the previous data with an error chip.
// Never prints secret values.
import pg from "pg";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, redact } from "../lib/env.mjs";
import { cleanSnapshot, deployFromRuns } from "./snapshot.mjs";
import { renderPage } from "./render.mjs";

function config() {
  const env = { ...loadEnv(process.env.STATS_ENV_FILE || join(process.cwd(), ".env.local")), ...process.env };
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(env.SUPABASE_URL || "")?.[1];
  const hostCache = join(process.cwd(), "supabase", ".temp", "pooler-host");
  const host = env.STATS_DB_HOST || env.SUPABASE_DB_HOST || (existsSync(hostCache) ? readFileSync(hostCache, "utf8").trim() : "");
  const user = env.STATS_DB_USER || (ref ? `hb_stats.${ref}` : "");
  const missing = [["STATS_DB_HOST", host], ["STATS_DB_USER", user], ["STATS_DB_PASSWORD", env.STATS_DB_PASSWORD]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`stats: missing ${missing.join(", ")} (see SETUP.md → "לוח ניהול")`);
    process.exit(2);
  }
  return {
    env, host, user, password: env.STATS_DB_PASSWORD,
    out: env.STATS_OUT_DIR || join(process.cwd(), "scratch", "stats-out"),
    repo: env.STATS_GITHUB_REPO || "elad-vibes/household-budget",
  };
}

async function snapshot(c) {
  const client = new pg.Client({
    host: c.host, port: 5432, database: "postgres", user: c.user, password: c.password,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, statement_timeout: 15000,
    application_name: "hb-admin-stats",
  });
  await client.connect();
  try {
    return (await client.query("select public.stats_snapshot() as s")).rows[0].s;
  } finally {
    await client.end();
  }
}

async function deploy(repo) {
  const base = `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=1`;
  const get = async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": "hb-admin-stats", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`github ${res.status}`);
    return res.json();
  };
  try {
    return deployFromRuns(await get(base), await get(`${base}&status=success`));
  } catch (e) {
    console.error(`stats: deploy info unavailable (${e.message})`);
    return null;
  }
}

function writeAtomic(file, text) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

async function main() {
  const c = config();
  mkdirSync(c.out, { recursive: true });
  const jsonFile = join(c.out, "stats.json");
  let stats;
  let failed = false;
  try {
    const [raw, dep] = await Promise.all([snapshot(c), deploy(c.repo)]);
    stats = cleanSnapshot(raw, dep);
    writeAtomic(jsonFile, JSON.stringify(stats, null, 1));
  } catch (e) {
    failed = true;
    console.error(`stats: ${redact(c.env, e.message)}`);
    if (!existsSync(jsonFile)) process.exit(1);
    stats = { ...JSON.parse(readFileSync(jsonFile, "utf8")), collector_error: /password|auth/i.test(e.message) ? "סיסמה" : "חיבור" };
  }
  writeAtomic(join(c.out, "index.html"), renderPage(stats));
  console.log(`stats: ${failed ? "FAILED (old data shown)" : "ok"} · ${stats.households.total} households · $${stats.ai.month_usd} · ${new Date().toISOString()}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`stats: ${e.message}`);
  process.exit(1);
});
