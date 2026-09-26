// Type-checks every Edge Function entry point with Deno (same runtime as Supabase).
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "supabase", "functions");
// Run the launcher with node directly (no shell: the project path contains spaces and Hebrew).
const launcher = join(process.cwd(), "node_modules", "deno", "bin.cjs");
let failed = 0;
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (name.startsWith("_") || !existsSync(join(dir, "index.ts"))) continue;
  try {
    execFileSync(process.execPath, [launcher, "check", "--quiet", "index.ts"], { cwd: dir, stdio: "pipe" });
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${String(e.stdout || "") + String(e.stderr || "")}`);
  }
}
process.exit(failed ? 1 : 0);
