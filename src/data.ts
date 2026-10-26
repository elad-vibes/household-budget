// Data access: loading a household, realtime updates and every mutation.
// All reads/writes go through RLS with the user's session.
import type { RealtimeChannel } from "@supabase/supabase-js";
import { sb, invoke } from "./lib/supa.ts";
import { S, rerender, mfaNeeded } from "./state.ts";
import type { Analysis, Fixed, Household, Invite, Member, Person, Settings, ShopItem, Tx, Usage } from "./domain/types.ts";
import type { PaymentMethod } from "./domain/match.ts";

const HH_KEY = "hb2-hh";
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function normTx(r: any): Tx {
  return { ...r, amount: num(r.amount) };
}
function normFixed(r: any): Fixed {
  return { ...r, amount: num(r.amount), cycle: (Number(r.cycle) || 1) as 1 | 2 | 12 };
}

// -------------------------------------------------------------- session
export async function refreshAal() {
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  S.aal = { current: data?.currentLevel ?? "aal1", next: data?.nextLevel ?? "aal1" };
  const { data: f } = await sb.auth.mfa.listFactors();
  S.hasFactor = !!f?.all?.some((x: any) => x.status === "verified" && x.factor_type !== "recovery_code");
}

export async function loadHouseholds() {
  const { data, error } = await sb.from("household_members").select("household_id, role, households(name)").eq("user_id", S.user!.id);
  if (error) throw error;
  S.households = (data ?? []).map((r: any) => ({ id: r.household_id, role: r.role, name: r.households?.name ?? "" })) as Household[];
  const saved = localStorage.getItem(HH_KEY);
  const pick = S.households.find((h) => h.id === saved) ?? S.households[0] ?? null;
  S.hh = pick?.id ?? null;
  S.role = pick?.role ?? null;
  const { data: adm } = await sb.rpc("am_i_admin");
  S.isAdmin = !!adm;
}

export function chooseHousehold(id: string) {
  const h = S.households.find((x) => x.id === id);
  if (!h) return;
  S.hh = h.id;
  S.role = h.role;
  localStorage.setItem(HH_KEY, h.id);
}

export async function loadSettings() {
  const { data, error } = await sb.from("household_settings").select("*").eq("household_id", S.hh!).maybeSingle();
  if (error) throw error;
  S.settings = data ? ({ ...data, quota_usd: num(data.quota_usd) } as Settings) : null;
}

// -------------------------------------------------------------- loading
async function fetchAll<T>(table: string, order: string, map: (r: any) => T = (r) => r): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select("*").eq("household_id", S.hh!).order(order).range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []).map(map));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadHousehold() {
  if (!S.hh) return;
  const hh = S.hh;
  const [people, tx, fixed, shop, analyses, members, profiles, methods] = await Promise.all([
    fetchAll<Person>("people", "sort"),
    fetchAll<Tx>("transactions", "date", normTx),
    fetchAll<Fixed>("fixed_expenses", "created_at", normFixed),
    fetchAll<ShopItem>("shopping_items", "sort"),
    fetchAll<any>("analyses", "month"),
    sb.from("household_members").select("user_id, role, joined_at").eq("household_id", hh),
    sb.from("profiles").select("user_id, display_name"),
    fetchAll<PaymentMethod>("payment_methods", "sort"),
  ]);
  if (S.hh !== hh) return; // switched meanwhile
  S.people = people;
  S.tx = tx;
  S.fixed = fixed;
  S.shop = shop;
  S.methods = methods;
  S.analyses = Object.fromEntries(analyses.map((a: any) => [a.month, { month: a.month, data: a.data, created_at: a.created_at, model: a.model } as Analysis]));
  const names = new Map((profiles.data ?? []).map((p: any) => [p.user_id, p.display_name]));
  S.members = (members.data ?? []).map((m: any) => ({ ...m, display_name: names.get(m.user_id) || "" })) as Member[];
  await Promise.all([loadInvites(), loadUsage()]);
  S.loaded = true;
}

export async function loadInvites() {
  if (S.role !== "owner") { S.invites = []; return; }
  const { data } = await sb.from("invites").select("id, role, person_name, created_at, expires_at, used_at, revoked_at, claimed_email")
    .eq("household_id", S.hh!).order("created_at", { ascending: false }).limit(30);
  S.invites = (data ?? []) as Invite[];
}

export async function loadUsage() {
  const { data } = await sb.rpc("household_usage", { p_household: S.hh });
  S.usage = data ? ({ ...data, usd: num(data.usd), quota_usd: num(data.quota_usd) } as Usage) : null;
}

// -------------------------------------------------------------- realtime
let channel: RealtimeChannel | null = null;
export function subscribe() {
  if (channel) sb.removeChannel(channel);
  if (!S.hh) return;
  const hh = S.hh;
  channel = sb.channel(`hh-${hh}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${hh}` }, (p: any) => {
      if (p.eventType === "DELETE") S.shop = S.shop.filter((i) => i.id !== p.old.id);
      else {
        const row = p.new as ShopItem;
        S.shop = [...S.shop.filter((i) => i.id !== row.id), row];
      }
      rerender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "transactions", filter: `household_id=eq.${hh}` }, (p: any) => {
      if (p.eventType === "DELETE") S.tx = S.tx.filter((t) => t.id !== p.old.id);
      else {
        const row = normTx(p.new);
        S.tx = [...S.tx.filter((t) => t.id !== row.id), row];
      }
      rerender();
    })
    .subscribe();
}
export function unsubscribe() {
  if (channel) sb.removeChannel(channel);
  channel = null;
}

// ------------------------------------------------------------ mutations
function check<T>(r: { data: T; error: any }): T {
  if (r.error) throw r.error;
  return r.data;
}

export async function insertTx(rows: Omit<Tx, "id" | "household_id">[]): Promise<Tx[]> {
  const out: Tx[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, household_id: S.hh }));
    const data = check(await sb.from("transactions").insert(chunk).select("*"));
    out.push(...(data ?? []).map(normTx));
  }
  S.tx = [...S.tx.filter((t) => !out.some((o) => o.id === t.id)), ...out];
  return out;
}
export async function updateTx(id: string, patch: Partial<Tx>) {
  const data = check(await sb.from("transactions").update(patch).eq("id", id).select("*").single());
  S.tx = S.tx.map((t) => (t.id === id ? normTx(data) : t));
}
export async function deleteTx(id: string) {
  check(await sb.from("transactions").delete().eq("id", id));
  S.tx = S.tx.filter((t) => t.id !== id);
}

// ------------------------------------------------------ payment methods
export async function savePaymentMethod(m: Partial<PaymentMethod> & { id?: string }) {
  const { id, household_id: _h, ...patch } = m;
  const data = id
    ? check(await sb.from("payment_methods").update(patch).eq("id", id).select("*").single())
    : check(await sb.from("payment_methods").insert({ ...patch, household_id: S.hh }).select("*").single());
  S.methods = [...S.methods.filter((x) => x.id !== (data as PaymentMethod).id), data as PaymentMethod];
  return data as PaymentMethod;
}
export async function deletePaymentMethod(id: string) {
  check(await sb.from("payment_methods").delete().eq("id", id));
  S.methods = S.methods.filter((x) => x.id !== id);
}
/** One statement import in one transaction: insert new rows, merge waiting rows, flag leftovers (0008). */
export async function applyStatement(methodId: string | null, rows: unknown[], merges: { id: string; date: string; month: string; amount: number }[], leftovers: string[]) {
  const r = check(await sb.rpc("apply_statement", { p_household: S.hh, p_method: methodId, p_rows: rows, p_merges: merges, p_leftovers: leftovers })) as
    { inserted: number; merged: number; unmatched: number };
  await reloadTx();
  return r;
}
/** Statement imported first: the logged row takes over the statement row. */
export async function mergeStatementRow(keepId: string, statementId: string) {
  check(await sb.rpc("merge_statement_row", { p_keep: keepId, p_statement: statementId }));
  await reloadTx();
}
export async function reloadTx() {
  S.tx = await fetchAll<Tx>("transactions", "date", normTx);
}

export async function saveFixed(f: Partial<Fixed> & { id?: string }) {
  const row = { ...f, household_id: S.hh };
  const data = f.id
    ? check(await sb.from("fixed_expenses").update(row).eq("id", f.id).select("*").single())
    : check(await sb.from("fixed_expenses").insert(row).select("*").single());
  const nf = normFixed(data);
  S.fixed = [...S.fixed.filter((x) => x.id !== nf.id), nf];
}
export async function deleteFixed(id: string) {
  check(await sb.from("fixed_expenses").delete().eq("id", id));
  S.fixed = S.fixed.filter((x) => x.id !== id);
}

export async function addShop(names: string[]) {
  const base = Date.now();
  const rows = names.map((n, i) => ({ household_id: S.hh, name: n.slice(0, 60), qty: 1, done: false, sort: base + i }));
  const data = check(await sb.from("shopping_items").insert(rows).select("*"));
  S.shop = [...S.shop.filter((i) => !(data ?? []).some((d: any) => d.id === i.id)), ...((data ?? []) as ShopItem[])];
}
export async function updateShop(id: string, patch: Partial<ShopItem>) {
  S.shop = S.shop.map((i) => (i.id === id ? { ...i, ...patch } : i));
  check(await sb.from("shopping_items").update(patch).eq("id", id));
}
export async function deleteShop(ids: string[]) {
  S.shop = S.shop.filter((i) => !ids.includes(i.id));
  if (ids.length) check(await sb.from("shopping_items").delete().in("id", ids));
}

export async function addPerson(name: string, legacyKey: string | null = null): Promise<Person> {
  const sort = Math.max(0, ...S.people.map((p) => p.sort)) + 1;
  const data = check(await sb.from("people").insert({ household_id: S.hh, name: name.slice(0, 30), sort, legacy_key: legacyKey }).select("*").single()) as Person;
  S.people = [...S.people, data];
  return data;
}
export async function updatePerson(id: string, patch: Partial<Person>) {
  check(await sb.from("people").update(patch).eq("id", id));
  S.people = S.people.map((p) => (p.id === id ? { ...p, ...patch } : p));
}
export async function deletePerson(id: string) {
  check(await sb.from("people").delete().eq("id", id));
  S.people = S.people.filter((p) => p.id !== id);
}

export async function updateSettings(patch: Partial<Settings>) {
  check(await sb.from("household_settings").update(patch).eq("household_id", S.hh!));
  S.settings = { ...S.settings!, ...patch };
}
export async function renameHousehold(name: string) {
  check(await sb.from("households").update({ name }).eq("id", S.hh!));
  S.households = S.households.map((h) => (h.id === S.hh ? { ...h, name } : h));
}
export async function setMyName(name: string) {
  check(await sb.from("profiles").upsert({ user_id: S.user!.id, display_name: name.slice(0, 40) }));
  S.members = S.members.map((m) => (m.user_id === S.user!.id ? { ...m, display_name: name } : m));
}

export async function createInvite(role: string, personName: string): Promise<string> {
  const token = check(await sb.rpc("create_invite", { p_household: S.hh, p_role: role, p_person_name: personName || null })) as string;
  await loadInvites();
  return token;
}
export async function revokeInvite(id: string) {
  check(await sb.rpc("revoke_invite", { p_invite: id }));
  await loadInvites();
}
export async function setRole(userId: string, role: string) {
  check(await sb.rpc("set_member_role", { p_household: S.hh, p_user: userId, p_role: role }));
  S.members = S.members.map((m) => (m.user_id === userId ? { ...m, role: role as Member["role"] } : m));
}
/** Owner → member, target → owner, in one transaction (0007). Needs a reload: my role changed. */
export async function transferOwnership(userId: string) {
  check(await sb.rpc("transfer_ownership", { p_household: S.hh, p_new_owner: userId }));
}
export async function removeMember(userId: string) {
  check(await sb.rpc("remove_member", { p_household: S.hh, p_user: userId }));
  S.members = S.members.filter((m) => m.user_id !== userId);
}
export async function deleteHousehold() {
  check(await sb.rpc("delete_household", { p_household: S.hh }));
}
export async function setRequireMfa(on: boolean) {
  check(await sb.rpc("set_require_mfa", { p_household: S.hh, p_on: on }));
  S.settings = { ...S.settings!, require_mfa: on };
}

export async function upsertAnalysis(month: string, data: unknown) {
  check(await sb.from("analyses").upsert({ household_id: S.hh, month, data }, { onConflict: "household_id,month" }));
}

// ---------------------------------------------------------- functions
export const fn = {
  analyze: (month: string, summary: string) => invoke<{ analysis: Analysis & { at: string } }>("analyze-month", { household_id: S.hh, month, summary }),
  statement: (files: { media_type: string; data: string }[], hints: { name: string; keyword: string }[]) =>
    invoke<{ doc: any }>("extract-statement", { household_id: S.hh, files, fixed_hints: hints }),
  receipts: (receipts: { client_id: string; person_id: string | null; media_type: string; data: string }[]) =>
    invoke<{ job_id: string; accepted: string[] }>("submit-receipts", { household_id: S.hh, receipts }),
  inviteInfo: (token: string) => invoke<{ household_name: string; role: string; person_name: string | null }>("invite-signin", { action: "info", token }),
  inviteClaim: (token: string, email: string) => invoke("invite-signin", { action: "claim", token, email }),
  deleteAccount: () => invoke("delete-account", { confirm: "מחיקה" }),
  mfaRecover: (code: string) => invoke("mfa-recover", { code }),
  mfaReset: (userId: string) => invoke("mfa-reset", { household_id: S.hh, user_id: userId }),
  priceCompare: () => invoke<{ cached: boolean; result: import("./ui/price.ts").PriceResult }>("price-compare", { household_id: S.hh }),
  priceSimilar: (q: string) => invoke<{ similar: { name: string; brand: string }[] }>("price-compare", { household_id: S.hh, similar: q }),
};

/** After sign-in: load everything for the current household (or decide which gate to show). */
export async function bootHousehold(): Promise<"ok" | "mfa-challenge" | "mfa-enroll" | "none"> {
  await refreshAal();
  await loadHouseholds();
  if (!S.hh) return "none";
  await loadSettings();
  if (mfaNeeded() && S.aal.current !== "aal2") return S.hasFactor ? "mfa-challenge" : "mfa-enroll";
  await loadHousehold();
  subscribe();
  return "ok";
}
