// E2E fixtures on the LIVE Supabase project (local runs only — needs the secret
// key from .env.local, never in CI). Everything created here is synthetic and
// deleted again by destroyFixture().
import { createClient, type Session } from "@supabase/supabase-js";
import { createHmac, randomBytes } from "node:crypto";
import { loadEnv } from "../../scripts/lib/env.mjs";
import { NAMES } from "../fixtures/synthetic.ts";

const env = loadEnv();
export const hasLive = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_ANON_KEY);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = () => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);

export interface Fixture { run: string; householdId: string; userIds: string[]; member: Session; owner: Session }

/** RFC 6238 TOTP (SHA-1, 30s, 6 digits) — used to pass the owner's 2FA in tests. */
export function totp(secretB32: string, t = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function user(run: string, role: string) {
  const email = `e2e-${role}-${run}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return { id: data.user.id, email, password };
}

async function signIn(email: string, password: string) {
  const c = anon();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn failed: ${error?.message}`);
  return { client: c, session: data.session };
}

export async function createFixture(): Promise<Fixture> {
  const run = Date.now().toString(36);
  const a = admin();
  const member = await user(run, "member");
  const owner = await user(run, "owner");
  const { data: hh, error } = await a.from("households").insert({ name: `${NAMES.hhA} (e2e ${run})` }).select("id").single();
  if (error) throw new Error(`household: ${error.message}`);
  const householdId = hh.id as string;
  const must0 = (r: { error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); };
  must0(await a.from("household_members").insert([
    { household_id: householdId, user_id: member.id, role: "member" },
    { household_id: householdId, user_id: owner.id, role: "owner" },
  ]), "members");
  const { data: people } = await a.from("people").insert([
    { household_id: householdId, name: NAMES.a1, user_id: member.id, sort: 1 },
    { household_id: householdId, name: NAMES.kid, sort: 2 },
  ]).select("id");
  await a.from("profiles").insert([{ user_id: member.id, display_name: NAMES.a1 }, { user_id: owner.id, display_name: NAMES.b1 }]);
  const now = new Date();
  const m = (k: number) => { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const rows = [0, 1, 2].flatMap((k) => [
    { date: `${m(k)}-03`, merchant: "סופר השכונה", amount: 812.4 + k * 40, category: "סופר ומכולת" },
    { date: `${m(k)}-05`, merchant: "חברת החשמל", amount: 390 + k * 12, category: "חשבונות בית", is_fixed: true },
    { date: `${m(k)}-08`, merchant: "נטפליקס", amount: 54.9, category: "תקשורת ומנויים" },
    { date: `${m(k)}-12`, merchant: "וולט", amount: 96.5, category: "אוכל בחוץ ומשלוחים" },
  ]).map((r) => ({ household_id: householdId, month: r.date.slice(0, 7), person_id: people?.[0]?.id ?? null, created_by: member.id,
    is_fixed: false, status: "saved", source: "manual", ...r }));
  rows.push({ household_id: householdId, date: `${m(0)}-15`, month: m(0), merchant: "קבלה מהמכולת", amount: 43.9, category: "סופר ומכולת",
    person_id: null, created_by: member.id, is_fixed: false, status: "review", source: "receipt" });
  const must = (r: { error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); };
  must(await a.from("transactions").insert(rows), "transactions");
  must(await a.from("fixed_expenses").insert({ household_id: householdId, name: "חשמל", amount: 400, keyword: "חברת החשמל", category: "חשבונות בית" }), "fixed");
  must(await a.from("shopping_items").insert([{ household_id: householdId, name: "חלב", qty: 2, created_by: member.id }, { household_id: householdId, name: "לחם", qty: 1, created_by: member.id }]), "shopping");

  const mem = await signIn(member.email, member.password);
  // Owner: enroll + verify TOTP so the session is aal2 (owners must use 2FA).
  const own = await signIn(owner.email, owner.password);
  const { data: f, error: fe } = await own.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "e2e" });
  if (fe || !f) throw new Error(`mfa enroll: ${fe?.message}`);
  const { error: ve } = await own.client.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
  if (ve) throw new Error(`mfa verify: ${ve.message}`);
  const { data: s2 } = await own.client.auth.getSession();
  return { run, householdId, userIds: [member.id, owner.id], member: mem.session, owner: s2.session! };
}

export async function destroyFixture(f: Pick<Fixture, "householdId" | "userIds">) {
  const a = admin();
  await a.from("households").delete().eq("id", f.householdId);
  for (const id of f.userIds) await a.auth.admin.deleteUser(id);
}

/** localStorage payload that makes the app start signed in (supabase-js storageKey "hb2-auth"). */
export const storageFor = (s: Session) => JSON.stringify(s);
