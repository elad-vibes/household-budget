// Executes a backup import (prototype hb-data-v1 or app v2) into the current
// household, and exports JSON / Excel.
import { exportV2, LEGACY_KEY, parseBackup, planImport } from "./domain/backup.ts";
import { THEMES } from "./domain/categories.ts";
import { addPerson, addShop, insertTx, saveFixed, updateSettings, upsertAnalysis } from "./data.ts";
import { ctx, S, household, startDay } from "./state.ts";
import { budgetMonth, rangeLabel } from "./domain/month.ts";
import { yearReport } from "./domain/plan.ts";
import { mLabel } from "./lib/format.ts";
import { downloadBlob } from "./ui/common.ts";

export function legacyData(): any | null {
  try {
    const d = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    return d && Array.isArray(d.batches) && d.batches.some((b: any) => (b?.items ?? []).length) ? d : null;
  } catch {
    return null;
  }
}
export const legacyCount = (d: any) => (d?.batches ?? []).reduce((a: number, b: any) => a + (b?.items ?? []).length, 0);

export async function importBackup(raw: unknown): Promise<string> {
  const b = parseBackup(raw);
  const plan = planImport(b, S.people, S.tx);
  for (const p of plan.newPeople) plan.personMap[p.key] = (await addPerson(p.name, p.key.slice(0, 20))).id;
  const pid = (k: string | null) => (k ? plan.personMap[k] ?? null : null);
  const inserted = await insertTx(plan.tx.map((t) => ({
    date: t.date, month: t.month, merchant: t.merchant, amount: t.amount, category: t.category, is_fixed: t.is_fixed,
    note: t.note, person_id: pid(t.personKey), source: "backup" as const, source_title: t.source_title || "גיבוי", status: "saved" as const,
  })));
  let fixedN = 0;
  for (const f of b.fixed) {
    if (S.fixed.some((x) => x.keyword.trim() === f.keyword.trim() && x.name.trim() === f.name.trim())) continue;
    await saveFixed({ name: f.name, amount: f.amount, keyword: f.keyword, category: f.category, person_id: pid(f.personKey), cycle: f.cycle, due_day: f.due_day, note: f.note });
    fixedN++;
  }
  const shopNew = b.shop.filter((i) => !i.done && !S.shop.some((x) => x.name === i.name)).map((i) => i.name);
  if (shopNew.length) await addShop(shopNew);
  for (const a of b.analyses) if (!S.analyses[a.month]) await upsertAnalysis(a.month, a.data);
  if (b.theme && THEMES[b.theme] && S.settings?.theme === "max") await updateSettings({ theme: b.theme });
  return `✓ נטענו ${inserted.length} תנועות${plan.skippedDup ? ` (${plan.skippedDup} כפולות דולגו)` : ""}, ${fixedN} קבועות${plan.newPeople.length ? `, ${plan.newPeople.length} בני בית חדשים` : ""}.`;
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function exportJson() {
  const data = exportV2({
    householdName: household()?.name ?? "", people: S.people, tx: S.tx, fixed: S.fixed, shop: S.shop,
    analyses: Object.values(S.analyses).map((a) => ({ month: a.month, data: a.data })), theme: S.settings?.theme ?? "max",
  });
  downloadBlob(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), `גיבוי-הכסף-של-הבית-${stamp()}.json`);
}

export async function exportExcel() {
  const XLSX = await import("xlsx");
  const pn = (id: string | null) => (id ? S.people.find((p) => p.id === id)?.name ?? "" : "משותף");
  const wb = XLSX.utils.book_new();
  const st = startDay();
  const tx = S.tx.filter((t) => t.status === "saved").sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => ({ "תאריך": t.date, "חודש": t.month, ...(st > 1 ? { "חודש תקציב": budgetMonth(t, st) } : {}), "בית עסק": t.merchant, "סכום": t.amount, "קטגוריה": t.category, "קבוע": t.is_fixed ? "כן" : "", "של מי": pn(t.person_id), "הערה": t.note, "מקור": t.source_title }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tx), "תנועות");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.fixed.map((f) => ({ "שם": f.name, "סכום": f.amount, "מילת חיפוש": f.keyword, "קטגוריה": f.category, "תדירות (חודשים)": f.cycle, "יום חיוב": f.due_day ?? "" }))), "קבועות");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.shop.map((i) => ({ "פריט": i.name, "כמות": i.qty, "נקנה": i.done ? "כן" : "" }))), "קניות");
  if (!wb.Workbook) wb.Workbook = {};
  wb.Workbook.Views = [{ RTL: true }];
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `הכסף-של-הבית-${stamp()}.xlsx`);
}

/** Yearly report (feature 3): 12 budget months × category, ending at `lastMonth`, as one sheet. */
export async function exportYear(lastMonth: string) {
  const XLSX = await import("xlsx");
  const st = startDay();
  const y = yearReport(ctx(), lastMonth);
  const head = ["קטגוריה", ...y.months.map((m) => (st > 1 ? `${mLabel(m)} (${rangeLabel(m, st)})` : mLabel(m))), "סה\"כ"];
  const rows = [head, ...y.rows.map((r) => [r.category, ...r.byMonth, r.total]), ["סה\"כ", ...y.totals, y.total]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "דוח שנתי");
  if (!wb.Workbook) wb.Workbook = {};
  wb.Workbook.Views = [{ RTL: true }];
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `דוח-שנתי-עד-${lastMonth}.xlsx`);
}
