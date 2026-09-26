// Creates the synthetic live fixture before the run and returns the teardown.
import { mkdirSync, writeFileSync } from "node:fs";
import { createFixture, destroyFixture, hasLive } from "./live.ts";

export const FIXTURE_FILE = "test-results/e2e-fixture.json";

export default async function globalSetup() {
  mkdirSync("test-results", { recursive: true });
  if (!hasLive || process.env.E2E_OFFLINE) {
    writeFileSync(FIXTURE_FILE, "null");
    return;
  }
  const f = await createFixture();
  writeFileSync(FIXTURE_FILE, JSON.stringify(f));
  return async () => {
    await destroyFixture(f);
    writeFileSync(FIXTURE_FILE, "null");
  };
}
