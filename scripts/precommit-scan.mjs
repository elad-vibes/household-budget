// סריקת בטיחות לפני קומיט — ported from the hub's engine/precommit_scan.py.
//
// Blocks a commit when what is ABOUT to be committed (the staged blobs, not the
// working tree) or the commit message contains:
//   * secrets: Supabase secret keys, Anthropic keys, JWTs, private keys,
//     any value from .env.local, or any staged .env* file
//   * card numbers (Luhn-valid), Israeli bank accounts / IBAN, Israeli ID numbers
//     (check digit), Israeli mobile numbers, e-mail addresses (except example/noreply)
//   * real names (local denylist built from the live DB) and data exports
//     (CSV/XLSX/JSON backups) — anywhere outside tests/fixtures/ (synthetic only)
//
//   node scripts/precommit-scan.mjs               staged files (pre-commit hook)
//   node scripts/precommit-scan.mjs --msg <file>  commit message (commit-msg hook)
//   node scripts/precommit-scan.mjs --all         every tracked file
//   node scripts/precommit-scan.mjs --refresh-names   rebuild .scan-denylist.txt from the DB
//
// Deliberate one-off bypass (only when you are sure): git commit --no-verify
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURES = "tests/fixtures/";
const DENYLIST = ".scan-denylist.txt";

// Patterns are assembled from pieces so this file does not match itself.
const SECRET_PATTERNS = [
  ["מפתח סודי של Supabase", new RegExp("sb_" + "secret_[A-Za-z0-9_-]{8,}")],
  ["מפתח Anthropic", new RegExp("sk-" + "ant-[A-Za-z0-9_-]{16,}")],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["מפתח פרטי", new RegExp("-----BEGIN [A-Z ]*" + "PRIVATE KEY-----")],
  ["טוקן GitHub", new RegExp("\\bgh[pousr]_" + "[A-Za-z0-9]{30,}")],
  ["טוקן Supabase אישי", new RegExp("\\bsbp_" + "[a-f0-9]{30,}")],
];

const ALLOWED_EMAIL_DOMAINS = /@(example\.(test|com|org|invalid)|users\.noreply\.github\.com|anthropic\.com)$/i;

export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Israeli ID (teudat zehut) check digit. */
export function israeliId(digits) {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = +digits[i] * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

const variety = (s) => new Set(s).size;
const mask = (s) => (s.length <= 4 ? "****" : "****" + s.slice(-4));
const isDataFile = (p) => /\.(csv|tsv|xlsx|xls|xlsm|ods|numbers|ofx|qif)$/i.test(p) ||
  (/\.json$/i.test(p) && !/(^|\/)(package(-lock)?|tsconfig|deno|manifest)\.json$/i.test(p));

/**
 * Scans one file's text. Returns [{kind, value}] (values already masked).
 * opts: { names: string[], envValues: {key,value}[], path }
 */
export function scanText(text, opts = {}) {
  const path = opts.path ?? "";
  const fixture = path.startsWith(FIXTURES);
  const out = [];
  const add = (kind, value) => out.push({ kind, value });

  for (const [kind, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) add(kind, mask(m[0]));
  }
  for (const { key, value } of opts.envValues ?? []) {
    if (value.length >= 8 && text.includes(value)) add("ערך מ-.env.local", key);
  }
  if (fixture) return out; // fixtures are synthetic by rule; secrets are still never allowed

  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    if (/scan-ok/.test(line)) return; // explicit, reviewable exception for a synthetic example
    for (const m of line.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
      const d = m[0].replace(/[ -]/g, "");
      if (d.length >= 13 && d.length <= 19 && variety(d) >= 4 && luhn(d)) add("מספר כרטיס אפשרי", mask(d));
    }
    for (const m of line.matchAll(/\bIL\d{2}(?:\s?\d{4}){4}\s?\d{3}\b/g)) add("IBAN", mask(m[0].replace(/\s/g, "")));
    for (const m of line.matchAll(/(?<![\d-])\d{2}-\d{3}-\d{5,9}(?![\d-])/g)) add("מספר חשבון בנק אפשרי", mask(m[0]));
    for (const m of line.matchAll(/(?<![\d.])\d{9}(?![\d.])/g)) {
      if (variety(m[0]) >= 4 && israeliId(m[0])) add("מספר ת\"ז אפשרי", mask(m[0]));
    }
    for (const m of line.matchAll(/(?<![\d])(?:\+972[- ]?|0)5\d[- ]?\d{3}[- ]?\d{4}(?!\d)/g)) add("מספר טלפון", mask(m[0].replace(/\D/g, "")));
    for (const m of line.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![w.-])/g)) { // letter TLD: "pkg@1.2.3" is not an address
      if (!ALLOWED_EMAIL_DOMAINS.test(m[0])) add("כתובת מייל", m[0].replace(/^(.).*@/, "$1***@"));
    }
    for (const n of opts.names ?? []) {
      if (n.length < 3) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      if (re.test(line)) add("שם אמיתי מהמערכת", n[0] + "…");
    }
  });
  if (/"format"\s*:\s*"hb-data-v2"/.test(text) || (/"batches"\s*:/.test(text) && /"items"\s*:/.test(text) && /"amount"\s*:/.test(text))) {
    add("קובץ גיבוי עם נתונים", path);
  }
  return out;
}

export function scanPath(path) {
  return isDataFile(path) && !path.startsWith(FIXTURES) ? [{ kind: "קובץ נתונים", value: path }] : [];
}

// ------------------------------------------------------------------ CLI
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function loadNames(root) {
  const p = join(root, DENYLIST);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 3);
}

function loadEnvValues(root) {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim().replace(/^["']|["']$/g, "") };
    })
    .filter((x) => x.value.length >= 8 && !/^https?:\/\//.test(x.value) && !/^smtp/i.test(x.value));
}

function report(findings, what) {
  if (!findings.length) {
    console.log(`pre-commit: נקי — ${what}.`);
    return 0;
  }
  console.log(`\n🔴 הקומיט נחסם — נמצאו פרטים שאסור שייכנסו לגיט:\n`);
  for (const f of findings.slice(0, 30)) console.log(`   ${f.file.padEnd(44)} ${f.kind.padEnd(22)} ${f.value}`);
  if (findings.length > 30) console.log(`   ... ועוד ${findings.length - 30}`);
  console.log("\nהכלל: בריפו אין סודות, אין מספרי כרטיס/חשבון/ת\"ז ואין נתונים אמיתיים של משפחות.");
  console.log(`נתוני בדיקה בדויים → ${FIXTURES}. דוגמה בדויה בשורה אחרת → להוסיף בה את המילה scan-ok.`);
  console.log("עקיפה מודעת (רק אם בטוחים): git commit --no-verify\n");
  return 1;
}

async function refreshNames(root) {
  const { default: pg } = await import("pg");
  const { loadEnv, projectRef } = await import("./lib/env.mjs");
  const env = loadEnv(join(root, ".env.local"));
  const host = readFileSync(join(root, "supabase", ".temp", "pooler-host"), "utf8").trim();
  const c = new pg.Client({ host, port: 5432, database: "postgres", user: `postgres.${projectRef(env)}`, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`
    select name as n from public.people
    union select display_name from public.profiles
    union select name from public.households
    union select split_part(email, '@', 1) from auth.users`);
  await c.end();
  const names = [...new Set(r.rows.map((x) => String(x.n ?? "").trim()).filter((s) => s.length >= 3))].sort();
  writeFileSync(join(root, DENYLIST), names.join("\n") + "\n", "utf8");
  console.log(`נשמרו ${names.length} שמות ב-${DENYLIST} (מקומי בלבד, לא בגיט).`);
}

async function main() {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  process.chdir(root);
  const args = process.argv.slice(2);
  if (args[0] === "--refresh-names") return refreshNames(root);
  const names = loadNames(root);
  const envValues = loadEnvValues(root);

  if (args[0] === "--msg") {
    const text = readFileSync(args[1], "utf8");
    const findings = scanText(text, { names, envValues, path: "הודעת הקומיט" }).map((f) => ({ file: "הודעת הקומיט", ...f }));
    process.exit(report(findings, "הודעת הקומיט"));
  }

  const all = args[0] === "--all";
  const files = (all ? git(["ls-files"]) : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]))
    .split(/\r?\n/).filter(Boolean);
  const findings = [];
  for (const file of files) {
    for (const f of scanPath(file)) findings.push({ file, ...f });
    if (/(^|\/)\.env(\.|$)/.test(file) && !/\.env\.example$/.test(file)) { findings.push({ file, kind: "קובץ .env", value: file }); continue; }
    if (/(^|\/)package-lock\.json$|\.(png|jpe?g|webp|ico|woff2?|gif|pdf)$/i.test(file)) continue;
    let text;
    try {
      text = all ? readFileSync(file, "utf8") : git(["show", `:${file}`]);
    } catch { continue; }
    if (text.includes("\u0000")) continue; // binary
    for (const f of scanText(text, { names, envValues, path: file })) findings.push({ file, ...f });
  }
  process.exit(report(findings, `${files.length} קבצים`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
}
