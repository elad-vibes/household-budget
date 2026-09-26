// One-command setup of the live Supabase project (idempotent — safe to re-run).
// Runs every step the credentials in .env.local allow and says which were skipped.
//
//   node scripts/setup-remote.mjs              db + admin + secrets + functions + auth
//   node scripts/setup-remote.mjs --github     also: GitHub repo variables for the Pages build
//   node scripts/setup-remote.mjs --pages      also: switch GitHub Pages to "GitHub Actions"
//
// Never prints secret values.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadEnv, projectRef, redact } from "./lib/env.mjs";

const ROOT = process.cwd();
let env = loadEnv();
const ref = projectRef(env);
const args = new Set(process.argv.slice(2));
const REPO = "elad-vibes/household-budget";
const APP_URL = "https://elad-vibes.github.io/household-budget/";
const ORIGINS = "https://elad-vibes.github.io,http://localhost:5173,http://localhost:4173";
const results = [];
const step = (name, status, note = "") => { results.push({ name, status, note }); console.log(`${status === "done" ? "✓" : status === "skipped" ? "–" : "✗"} ${name}${note ? " — " + note : ""}`); };

function ensureLocalSecret(key, make) {
  if (env[key]) return env[key];
  const value = make();
  appendFileSync(join(ROOT, ".env.local"), `\n${key}=${value}\n`);
  env = loadEnv();
  return value;
}

async function db() {
  const host = readFileSync(join(ROOT, "supabase", ".temp", "pooler-host"), "utf8").trim();
  const c = new pg.Client({ host, port: 5432, database: "postgres", user: `postgres.${ref}`, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function stepDatabase() {
  execFileSync(process.execPath, ["scripts/db.mjs", "migrate"], { stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/db.mjs", "sql", "supabase/remote/realtime.sql"], { stdio: "inherit" });
  const cron = ensureLocalSecret("CRON_SECRET", () => randomBytes(32).toString("base64url"));
  const c = await db();
  try {
    for (const [name, value] of [["hb_project_url", env.SUPABASE_URL.replace(/\/$/, "")], ["hb_cron_secret", cron]]) {
      const r = await c.query("select id from vault.secrets where name = $1", [name]);
      if (r.rows.length) await c.query("select vault.update_secret($1, $2)", [r.rows[0].id, value]);
      else await c.query("select vault.create_secret($1, $2)", [value, name]);
    }
    await c.query(readFileSync(join(ROOT, "supabase", "remote", "cron.sql"), "utf8"));
  } finally {
    await c.end();
  }
  step("database: migrations, realtime, vault, cron", "done");
}

async function adminApi() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function stepSuperAdmin() {
  if (!env.SUPER_ADMIN_EMAIL) return step("super-admin", "skipped", "SUPER_ADMIN_EMAIL missing in .env.local");
  const a = await adminApi();
  const email = env.SUPER_ADMIN_EMAIL.trim().toLowerCase();
  const { error } = await a.auth.admin.createUser({ email, email_confirm: true });
  if (error && !/already|exists/i.test(error.message)) throw new Error("create super-admin failed");
  const c = await db();
  try {
    await c.query("insert into public.app_admins (user_id) select id from auth.users where lower(email) = $1 on conflict do nothing", [email]);
  } finally {
    await c.end();
  }
  step("super-admin", "done", "account exists and is in app_admins");
}

async function mgmt(method, path, body) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method, headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${redact(env, text).slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function stepSecrets() {
  if (!env.SUPABASE_ACCESS_TOKEN) return step("function secrets", "skipped", "SUPABASE_ACCESS_TOKEN missing");
  const secrets = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, SB_SECRET_KEY: env.SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET: env.CRON_SECRET,
    ALLOWED_ORIGINS: ORIGINS, APP_URL, VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: `mailto:${env.SUPER_ADMIN_EMAIL || env.SMTP_SENDER_EMAIL || "admin@example.invalid"}`,
  };
  const list = Object.entries(secrets).filter(([, v]) => v).map(([name, value]) => ({ name, value }));
  await mgmt("POST", "/secrets", list);
  step("function secrets", "done", `${list.length} secrets set`);
}

function stepFunctions() {
  if (!env.SUPABASE_ACCESS_TOKEN) return step("deploy Edge Functions", "skipped", "SUPABASE_ACCESS_TOKEN missing");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "supabase", "dist", "supabase.js"), "functions", "deploy", "--project-ref", ref, "--use-api"], {
    stdio: "inherit", env: { ...process.env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN },
  });
  step("deploy Edge Functions", "done");
}

const MAGIC_LINK_TEMPLATE = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6">
<h2 style="color:#00705F">הכסף של הבית</h2>
<p>הקוד שלכם לכניסה:</p>
<p style="font-size:30px;letter-spacing:8px;font-weight:bold;direction:ltr;text-align:right">{{ .Token }}</p>
<p>מקלידים אותו באפליקציה. אפשר גם ללחוץ על הקישור (עדיף בדפדפן שבו ביקשתם את הקוד):</p>
<p><a href="{{ .ConfirmationURL }}">כניסה להכסף של הבית</a></p>
<p style="color:#6F7B77;font-size:13px">הקוד תקף לשעה. אם לא ביקשתם להתחבר, אפשר להתעלם מהמייל.</p></div>`;

async function stepAuth() {
  if (!env.SUPABASE_ACCESS_TOKEN) return step("auth settings", "skipped", "SUPABASE_ACCESS_TOKEN missing");
  const cfg = {
    disable_signup: true,                  // joining only through invites (the invite-signin function creates users)
    external_email_enabled: true,
    mailer_autoconfirm: false,
    site_url: APP_URL,
    uri_allow_list: `${APP_URL}**,http://localhost:5173/household-budget/**`,
    mailer_otp_exp: 3600,
    mailer_subjects_magic_link: "קוד הכניסה שלכם להכסף של הבית",
    mailer_templates_magic_link_content: MAGIC_LINK_TEMPLATE,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
    mfa_phone_enroll_enabled: false,       // no SMS (cost, SIM-swap)
    mfa_phone_verify_enabled: false,
    mfa_max_enrolled_factors: 10,
    external_anonymous_users_enabled: false,
  };
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_SENDER_EMAIL) {
    Object.assign(cfg, {
      smtp_host: env.SMTP_HOST, smtp_port: String(env.SMTP_PORT || 587), smtp_user: env.SMTP_USER, smtp_pass: env.SMTP_PASS,
      smtp_admin_email: env.SMTP_SENDER_EMAIL, smtp_sender_name: "הכסף של הבית", smtp_max_frequency: 30, rate_limit_email_sent: 100,
    });
  }
  await mgmt("PATCH", "/config/auth", cfg);
  try {
    await mgmt("PATCH", "/config/auth", { mfa_web_authn_enroll_enabled: true, mfa_web_authn_verify_enabled: true });
  } catch { /* WebAuthn MFA not available on this project — the app hides the option */ }
  step("auth settings", "done", cfg.smtp_host ? "incl. SMTP" : "SMTP not set — built-in mailer (team members only!)");
}

function stepGithub() {
  if (!args.has("--github")) return step("GitHub repo variables", "skipped", "run with --github");
  const vars = { VITE_SUPABASE_URL: env.SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_ANON_KEY, VITE_VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY };
  for (const [k, v] of Object.entries(vars)) {
    if (/^sb_secret_/.test(v)) throw new Error(`${k} looks like a secret key — refusing`);
    execFileSync("gh", ["variable", "set", k, "--body", v, "-R", REPO], { stdio: "pipe" });
  }
  step("GitHub repo variables", "done", Object.keys(vars).join(", "));
}

function stepPages() {
  if (!args.has("--pages")) return step("GitHub Pages → Actions", "skipped", "run with --pages");
  try {
    execFileSync("gh", ["api", "-X", "PUT", `repos/${REPO}/pages`, "-f", "build_type=workflow"], { stdio: "pipe" });
  } catch {
    execFileSync("gh", ["api", "-X", "POST", `repos/${REPO}/pages`, "-f", "build_type=workflow"], { stdio: "pipe" });
  }
  step("GitHub Pages → Actions", "done");
}

for (const [name, fn] of [["database", stepDatabase], ["super-admin", stepSuperAdmin], ["secrets", stepSecrets],
  ["functions", stepFunctions], ["auth", stepAuth], ["github", stepGithub], ["pages", stepPages]]) {
  try {
    await fn();
  } catch (e) {
    step(name, "failed", redact(env, e?.message ?? String(e)));
  }
}
const failed = results.filter((r) => r.status === "failed").length;
console.log(`\n${results.filter((r) => r.status === "done").length} done · ${results.filter((r) => r.status === "skipped").length} skipped · ${failed} failed`);
process.exit(failed ? 1 : 0);
