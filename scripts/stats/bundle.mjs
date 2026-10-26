// Bundles the collector (+ pg) into ONE file for the server, so nothing has to be
// installed there:  npm run stats:bundle  →  dist-stats/collect.mjs  (not in git)
import { build } from "rolldown";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const file = "dist-stats/collect.mjs";
await build({
  input: "scripts/stats/collect.mjs",
  platform: "node",
  external: ["pg-native", "pg-cloudflare", "cloudflare:sockets"],
  logLevel: "warn",
  output: { file, format: "esm", codeSplitting: false },
});
const md5 = createHash("md5").update(readFileSync(file)).digest("hex");
console.log(`${file} · ${(readFileSync(file).length / 1024).toFixed(0)} KB · md5 ${md5}`);
