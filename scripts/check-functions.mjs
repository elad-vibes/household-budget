// Type-checks every Edge Function entry point with Deno (same runtime as Supabase).
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "supabase", "functions");
const deno = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "deno.cmd" : "deno");
let failed = 0;
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (name.startsWith("_") || !existsSync(join(dir, "index.ts"))) continue;
  try {
    execFileSync(deno, ["check", "--quiet", "index.ts"], { cwd: dir, stdio: "pipe", shell: process.platform === "win32" });
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${String(e.stdout || "") + String(e.stderr || "")}`);
  }
}
process.exit(failed ? 1 : 0);
