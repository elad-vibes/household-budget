// App state (one household at a time, like the prototype's S object).
import type { Ctx } from "./domain/calc.ts";
import type { Analysis, DraftDoc, Fixed, Household, Invite, Member, Person, Role, Settings, ShopItem, Tx, Usage } from "./domain/types.ts";
import type { QueuedReceipt } from "./lib/idb.ts";
import type { PaymentMethod } from "./domain/match.ts";
import { curMonth } from "./lib/format.ts";

export type View =
  | "loading" | "noconfig" | "signin" | "join" | "mfa-challenge" | "mfa-enroll" | "nohousehold" | "app" | "admin" | "install";

export type Tab = "overview" | "add" | "tx" | "fixed" | "plan" | "shop" | "home" | "log";

export const S = {
  view: "loading" as View,
  tab: "overview" as Tab,
  user: null as null | { id: string; email: string },
  aal: { current: "aal1", next: "aal1" } as { current: string; next: string },
  hasFactor: false,
  isAdmin: false,
  households: [] as Household[],
  hh: null as string | null,
  role: null as Role | null,
  settings: null as Settings | null,
  people: [] as Person[],
  members: [] as Member[],
  tx: [] as Tx[],
  fixed: [] as Fixed[],
  shop: [] as ShopItem[],
  methods: [] as PaymentMethod[],     // payment methods of the household (0008)
  analyses: {} as Record<string, Analysis>,
  invites: [] as Invite[],
  usage: null as Usage | null,
  queue: [] as QueuedReceipt[],
  loaded: false,
  month: curMonth(),
  monthTouched: false,
  fPerson: "all",
  fCat: "all",
  upPerson: "",               // "" = joint
  pending: null as null | { personId: string | null; docs: DraftDoc[] },
  busy: false,
  anBusy: false,
  editFx: null as string | null,
  joinToken: null as string | null,
  flash: null as null | { text: string; kind: "ok" | "err" | "info" | "warn" },
  extra: {} as Record<string, any>, // Phase 2 collections live here (budgets, goals…)
};

export const startDay = () => S.settings?.month_start_day ?? 1;
export const ctx = (): Ctx => ({ tx: S.tx, fixed: S.fixed, people: S.people, startDay: startDay() });
export const canWrite = () => S.role === "owner" || S.role === "member";
export const isOwner = () => S.role === "owner";
export const household = () => S.households.find((h) => h.id === S.hh) ?? null;

/** Does this household session need the second factor (same rule as the DB)? */
export function mfaNeeded(): boolean {
  return S.role === "owner" || S.hasFactor || !!S.settings?.require_mfa;
}

let renderer: () => void = () => {};
export const setRenderer = (fn: () => void) => { renderer = fn; };
export const rerender = () => renderer();

export function flash(text: string, kind: "ok" | "err" | "info" | "warn" = "ok") {
  S.flash = { text, kind };
  rerender();
  const mine = S.flash;
  setTimeout(() => { if (S.flash === mine) { S.flash = null; rerender(); } }, kind === "err" ? 7000 : 3500);
}
