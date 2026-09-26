// Reads .env.local (KEY=VALUE lines). Never prints values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnv(file = join(process.cwd(), ".env.local")) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

export function need(env, ...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing in .env.local: ${missing.join(", ")}`);
    process.exit(2);
  }
}

/** https://<ref>.supabase.co → <ref> */
export function projectRef(env) {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(env.SUPABASE_URL || "");
  if (!m) {
    console.error("SUPABASE_URL does not look like https://<ref>.supabase.co");
    process.exit(2);
  }
  return m[1];
}

/** Replaces any secret value that might appear in a message with ***. */
export function redact(env, text) {
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 6 && /KEY|PASSWORD|TOKEN|SECRET|PASS|URL/.test(k)) out = out.split(v).join("***");
  }
  return out;
}
