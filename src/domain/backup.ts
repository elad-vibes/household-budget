// Backups: export (JSON v2 + Excel) and import of both the new format and the
// prototype's "hb-data-v1" (so families can move their local data over).
import { ALLCATS } from "./categories.ts";
import { dupKey } from "./calc.ts";
import type { AnalysisData, Fixed, Person, ShopItem, Tx } from "./types.ts";

export const LEGACY_KEY = "hb-data-v1";

export interface NormPerson { key: string; name: string }
export interface NormTx { date: string; month: string; merchant: string; amount: number; category: string; is_fixed: boolean; note: string; personKey: string | null; source_title: string }
export interface NormFixed { name: string; amount: number; keyword: string; category: string; personKey: string | null; cycle: 1 | 2 | 12; note: string; due_day: number | null }
export interface NormBackup {
  version: 1 | 2;
  people: NormPerson[];
  tx: NormTx[];
  fixed: NormFixed[];
  shop: { name: string; qty: number; done: boolean }[];
  analyses: { month: string; data: AnalysisData }[];
  theme: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const s = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const n2 = (v: unknown) => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : NaN;
};

function normTx(it: any, personKey: string | null, sourceTitle: string): NormTx | null {
  const amount = n2(it?.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  let date = s(it?.date, 10);
  let month = s(it?.month, 7);
  if (!MONTH.test(month)) month = DATE.test(date) ? date.slice(0, 7) : "";
  if (!month) return null;
  if (!DATE.test(date)) date = `${month}-01`;
  return {
    date, month, merchant: s(it?.merchant, 120) || "לא ידוע", amount,
    category: ALLCATS.includes(it?.category) ? it.category : "שונות",
    is_fixed: !!(it?.fixed ?? it?.is_fixed), note: s(it?.note, 200), personKey, source_title: s(sourceTitle, 120),
  };
}

/** Accepts prototype (v1) and app (v2) backups. Throws a Hebrew message on garbage. */
export function parseBackup(d: any): NormBackup {
  if (!d || typeof d !== "object") throw new Error("זה לא נראה כמו קובץ גיבוי של האפליקציה.");
  if (d.format === "hb-data-v2") {
    return {
      version: 2,
      people: (d.people ?? []).map((p: any) => ({ key: s(p.key, 60), name: s(p.name, 30) })).filter((p: NormPerson) => p.key && p.name),
      tx: (d.transactions ?? []).map((t: any) => normTx(t, t.person ? s(t.person, 60) : null, t.source_title ?? "גיבוי")).filter(Boolean) as NormTx[],
      fixed: (d.fixed ?? []).map((f: any) => normFixed(f, f.person ? s(f.person, 60) : null)).filter(Boolean) as NormFixed[],
      shop: (d.shopping ?? []).map((i: any) => ({ name: s(i.name, 60), qty: Math.min(99, Math.max(1, Math.round(+i.qty || 1))), done: !!i.done })).filter((i: { name: string }) => i.name),
      analyses: (d.analyses ?? []).filter((a: any) => MONTH.test(a?.month) && a?.data?.status).map((a: any) => ({ month: a.month, data: a.data })),
      theme: typeof d.settings?.theme === "string" ? d.settings.theme : null,
    };
  }
  if (!Array.isArray(d.batches)) throw new Error("זה לא נראה כמו קובץ גיבוי של האפליקציה.");
  // ---- prototype v1
  const settings = d.settings && typeof d.settings === "object" ? d.settings : {};
  const people: NormPerson[] = Array.isArray(settings.people) && settings.people.length
    ? settings.people.map((p: any) => ({ key: s(p.id, 20), name: s(p.name, 30) })).filter((p: NormPerson) => p.key && p.name)
    : [{ key: "p1", name: s(settings.p1, 30) || "שלי" }, { key: "p2", name: s(settings.p2, 30) || "בעלי" }];
  const tx: NormTx[] = [];
  for (const b of d.batches) {
    for (const it of Array.isArray(b?.items) ? b.items : []) {
      const pk = s(it?.person || b?.person || "p1", 20);
      const t = normTx(it, pk === "joint" ? null : pk, b?.source ?? "גיבוי");
      if (t) tx.push(t);
    }
  }
  const fixed = (Array.isArray(d.fixed) ? d.fixed : [])
    .map((f: any) => normFixed(f, f?.person && f.person !== "any" ? s(f.person, 20) : null)).filter(Boolean) as NormFixed[];
  const shopSrc = Array.isArray(d.shop) ? d.shop : [];
  const analyses = d.analyses && typeof d.analyses === "object"
    ? Object.entries(d.analyses).filter(([m, a]: [string, any]) => MONTH.test(m) && a?.data?.status).map(([m, a]: [string, any]) => ({ month: m, data: a.data }))
    : [];
  return {
    version: 1, people, tx, fixed,
    shop: shopSrc.map((i: any) => ({ name: s(i?.name, 60), qty: Math.min(99, Math.max(1, Math.round(+i?.qty || 1))), done: !!i?.done })).filter((i: { name: string }) => i.name),
    analyses, theme: typeof settings.theme === "string" ? settings.theme : null,
  };
}

function normFixed(f: any, personKey: string | null): NormFixed | null {
  const amount = n2(f?.amount);
  const name = s(f?.name, 60), keyword = s(f?.keyword, 40);
  if (!name || !keyword || !Number.isFinite(amount)) return null;
  const cycle = [1, 2, 12].includes(+f?.cycle) ? (+f.cycle as 1 | 2 | 12) : 1;
  const due = +f?.due_day;
  return {
    name, amount, keyword, category: ALLCATS.includes(f?.category) ? f.category : "שונות", personKey, cycle,
    note: s(f?.note, 200), due_day: Number.isInteger(due) && due >= 1 && due <= 31 ? due : null,
  };
}

export interface ImportPlan {
  newPeople: NormPerson[];                  // to create (no name match)
  personMap: Record<string, string | null>; // backup key → existing person id (filled after creation)
  tx: NormTx[];                             // to insert (duplicates removed)
  skippedDup: number;
}

/** Decides which people to create and which transactions are new. Pure. */
export function planImport(b: NormBackup, existingPeople: Person[], existingTx: Tx[]): ImportPlan {
  const personMap: Record<string, string | null> = {};
  const newPeople: NormPerson[] = [];
  for (const p of b.people) {
    const match = existingPeople.find((e) => e.legacy_key === p.key) ??
      existingPeople.find((e) => !e.archived && e.name.trim().toLowerCase() === p.name.trim().toLowerCase());
    if (match) personMap[p.key] = match.id;
    else newPeople.push(p);
  }
  const seen = new Set(existingTx.map((t) => dupKey(t)));
  const tx: NormTx[] = [];
  let skippedDup = 0;
  for (const t of b.tx) {
    // key uses the backup person key for not-yet-created people; good enough for in-file dups
    const key = dupKey({ person_id: t.personKey ? (personMap[t.personKey] ?? `new:${t.personKey}`) : null, date: t.date, amount: t.amount, merchant: t.merchant });
    if (seen.has(key)) { skippedDup++; continue; }
    seen.add(key);
    tx.push(t);
  }
  return { newPeople, personMap, tx, skippedDup };
}

export interface ExportInput {
  householdName: string; people: Person[]; tx: Tx[]; fixed: Fixed[]; shop: ShopItem[];
  analyses: { month: string; data: AnalysisData }[]; theme: string;
}

export function exportV2(x: ExportInput) {
  return {
    format: "hb-data-v2",
    exportedAt: new Date().toISOString(),
    household: { name: x.householdName },
    settings: { theme: x.theme },
    people: x.people.map((p) => ({ key: p.id, name: p.name, archived: p.archived })),
    transactions: x.tx.filter((t) => t.status === "saved").map((t) => ({
      date: t.date, month: t.month, merchant: t.merchant, amount: t.amount, category: t.category,
      is_fixed: t.is_fixed, note: t.note, person: t.person_id, source_title: t.source_title,
    })),
    fixed: x.fixed.map((f) => ({ name: f.name, amount: f.amount, keyword: f.keyword, category: f.category, person: f.person_id, cycle: f.cycle, due_day: f.due_day, note: f.note })),
    shopping: x.shop.map((i) => ({ name: i.name, qty: i.qty, done: i.done })),
    analyses: x.analyses,
  };
}
