// Month math, fixed-expense matching, subscriptions, rule-based tips and the
// analysis summary — ported from the prototype. Pure functions over a context.
import { addM, ils, mLabel, norm } from "../lib/format.ts";
import { baseSymbol, region, regionCode } from "../lib/region.ts";
import { EXCL, SUBS } from "./categories.ts";
import { budgetMonth } from "./month.ts";
import type { AnalysisData, Fixed, Person, Tx } from "./types.ts";

/** startDay: the household's budget-month start (1–28, feature 3); every monthly number goes through txOf. */
export interface Ctx { tx: Tx[]; fixed: Fixed[]; people: Person[]; startDay?: number }

export const JOINT = "משותף";

export function activePeople(ctx: Ctx): Person[] {
  return ctx.people.filter((p) => !p.archived).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}
export function personName(ctx: Ctx, id: string | null | undefined): string {
  if (!id) return JOINT;
  return ctx.people.find((p) => p.id === id)?.name ?? "לשעבר";
}
/** [value, label] pairs for selects; "" = joint. */
export function personOptions(ctx: Ctx): [string, string][] {
  return [...activePeople(ctx).map((p) => [p.id, p.name] as [string, string]), ["", JOINT]];
}
const PCOLORS = ["var(--accent)", "#7B68D9", "#E07A5F", "#3BA3C7", "#B99A2E", "#C25FA0", "#5E9E6E"];
export function personColor(ctx: Ctx, id: string | null | undefined): string {
  if (!id) return "var(--muted)";
  const i = activePeople(ctx).findIndex((p) => p.id === id);
  return PCOLORS[(i < 0 ? 6 : i) % PCOLORS.length];
}

export const isExcl = (t: Pick<Tx, "category">) => (EXCL as readonly string[]).includes(t.category);

export function fixedMatch(ctx: Ctx, t: Pick<Tx, "merchant" | "person_id">): Fixed | undefined {
  const m = norm(t.merchant);
  return ctx.fixed.find((f) => {
    const k = norm(f.keyword);
    return k && m.includes(k) && (!f.person_id || f.person_id === t.person_id);
  });
}
export const isFixed = (ctx: Ctx, t: Tx) => t.is_fixed || !!fixedMatch(ctx, t);

export const savedTx = (ctx: Ctx) => ctx.tx.filter((t) => t.status === "saved");
export const reviewTx = (ctx: Ctx) => ctx.tx.filter((t) => t.status === "review");
export const monthOf = (ctx: Ctx, t: Tx) => budgetMonth(t, ctx.startDay);
export const txOf = (ctx: Ctx, m: string) => savedTx(ctx).filter((t) => monthOf(ctx, t) === m);
export const monthsWithData = (ctx: Ctx) => [...new Set(savedTx(ctx).map((t) => monthOf(ctx, t)))].sort();

export interface MonthSum { fx: number; vr: number; total: number; inc: number; count: number }
export function sumM(ctx: Ctx, m: string): MonthSum {
  const all = txOf(ctx, m);
  const t = all.filter((x) => !isExcl(x));
  let fx = 0, vr = 0;
  for (const x of t) {
    if (isFixed(ctx, x)) fx += x.amount;
    else vr += x.amount;
  }
  const inc = all.filter((x) => x.category === "הכנסה").reduce((a, x) => a + Math.abs(x.amount), 0);
  return { fx, vr, total: fx + vr, inc, count: t.length };
}

export interface SubHit { name: string; amount: number; n: number; links: string[] }
export function subsOf(ctx: Ctx, m: string): SubHit[] {
  const out: SubHit[] = [];
  const tx = txOf(ctx, m);
  for (const [name, re, links] of SUBS) {
    const hits = tx.filter((t) => re.test(t.merchant));
    if (hits.length) out.push({ name, amount: hits.reduce((a, t) => a + t.amount, 0), n: hits.length, links });
  }
  return out;
}

export function fixedActual(ctx: Ctx, f: Fixed, m: string) {
  const k = norm(f.keyword);
  const hits = txOf(ctx, m).filter((t) => k && norm(t.merchant).includes(k) && (!f.person_id || f.person_id === t.person_id));
  return { hits, amount: hits.reduce((a, t) => a + t.amount, 0) };
}

export function fixedStatus(ctx: Ctx, f: Fixed, m: string): { kind: "ok" | "miss" | "notthis" | "high" | "low"; actual: number; diff: number } {
  const { hits, amount } = fixedActual(ctx, f, m);
  if (!hits.length) return { kind: (f.cycle || 1) > 1 ? "notthis" : "miss", actual: 0, diff: 0 };
  if (Math.abs(amount - f.amount) <= Math.max(5, f.amount * 0.05)) return { kind: "ok", actual: amount, diff: 0 };
  return { kind: amount > f.amount ? "high" : "low", actual: amount, diff: Math.abs(amount - f.amount) };
}

/** Rule-based tips (the prototype's localTips) — the no-AI fallback. */
export function localTips(ctx: Ctx, m: string): AnalysisData | null {
  const tx = txOf(ctx, m).filter((x) => !isExcl(x));
  if (!tx.length) return null;
  const s = sumM(ctx, m);
  const tips: AnalysisData["tips"] = [];
  const checks: string[] = [];
  const sumRe = (re: RegExp) => tx.filter((t) => re.test(t.merchant)).reduce((a, t) => a + t.amount, 0);

  const th = regionCode() === "TH", k = region().thresholdScale;   // 0016: Israeli advice and links do not apply in Thailand
  const elec = sumRe(th ? /חשמל|electric|\bmea\b|\bpea\b|การไฟฟ้า/i : /חשמל/);
  if (th && elec > 250 * k) tips.push({ title: "לבדוק את חשבון החשמל", text: `החשמל החודש עלה ${ils(elec)}. התעריף בתאילנד מדורג לפי צריכה והמזגן הוא בדרך כלל החלק הגדול: כדאי לבדוק טמפרטורה ושעות שימוש, ובקונדו לוודא שנגבה התעריף הרשמי.`, save: Math.round(elec * 0.07), links: [] });
  if (!th && elec > 250) tips.push({ title: "לבדוק ספק חשמל פרטי", text: `החשמל החודש עלה ${ils(elec)}. ספקים פרטיים נותנים הנחה על התעריף של חברת החשמל, בלי החלפת מונה.`, save: Math.round(elec * 0.07), links: ["elec_cmp", "elec_gov"] });
  const ins = tx.filter((t) => t.category === "ביטוחים");
  if (th && ins.length >= 2) tips.push({ title: "לעשות סדר בביטוחים", text: `יש ${ins.length} חיובי ביטוח החודש (${ils(ins.reduce((a, t) => a + t.amount, 0))}). כדאי לוודא שאין כפל כיסוי בין ביטוח הבריאות, ביטוח הנסיעות וכרטיס האשראי, ולהשוות פרמיה לפני החידוש.`, save: null, links: [] });
  if (!th && ins.length >= 2) tips.push({ title: "לעשות סדר בביטוחים", text: `יש ${ins.length} חיובי ביטוח החודש (${ils(ins.reduce((a, t) => a + t.amount, 0))}). כדאי לבדוק בהר הביטוח שאין כפל, ולהשוות את ביטוח הרכב לפני החידוש.`, save: null, links: ["harb", "car_calc"] });
  const subs = subsOf(ctx, m);
  const subT = subs.reduce((a, x) => a + x.amount, 0);
  if (subs.length) tips.push({ title: "לעבור על המנויים", text: `${subs.map((x) => x.name).join(", ")}: ${ils(subT, subT % 1 ? 2 : 0)} בחודש. כדאי לבטל את מה שלא משתמשים בו או לבדוק אם זה כלול בחבילה.`, save: null, links: [...new Set(subs.flatMap((x) => x.links))] });
  const tel = tx.filter((t) => t.category === "תקשורת ומנויים" && t.amount > 25).reduce((a, t) => a + t.amount, 0);
  if (tel > 150 * k) tips.push({ title: "להשוות חבילות תקשורת", text: `תקשורת ומנויים החודש: ${ils(tel)}. שווה לבדוק אם יש חבילה זולה יותר לסלולר, לאינטרנט או לטלוויזיה.`, save: Math.round(tel * 0.15), links: th ? [] : ["cell_cmp", "comm_cmp"] });
  const groc = tx.filter((t) => t.category === "סופר ומכולת");
  const small = groc.filter((t) => t.amount > 0 && t.amount < region().smallPurchase).length;
  const gT = groc.reduce((a, t) => a + t.amount, 0);
  if (small >= 6 || gT > 1500 * k) tips.push({ title: "לרכז את הקניות בסופר", text: `${groc.length} קניות בסופר ובמכולת (${ils(gT)}), מתוכן ${small} קטנות. קנייה גדולה אחת בשבוע ברשת זולה חוסכת בדרך כלל כמה אחוזים.`, save: Math.round(gT * 0.06), links: th ? [] : ["chp", "pricez"] });
  const food = tx.filter((t) => t.category === "אוכל בחוץ ומשלוחים").reduce((a, t) => a + t.amount, 0);
  if (s.total && food / s.total > 0.08) tips.push({ title: "אוכל בחוץ ומשלוחים", text: `${ils(food)} החודש (${Math.round((food / s.total) * 100)}% מההוצאות). אפשר לקבוע תקציב שבועי למשלוחים.`, save: Math.round(food * 0.25), links: [] });
  const onl = tx.filter((t) => t.category === "קניות אונליין").reduce((a, t) => a + t.amount, 0);
  if (onl > 250 * k) tips.push({ title: "קניות אונליין קטנות", text: `${ils(onl)} בקניות אונליין. כדאי לחכות כמה ימים לפני קנייה קטנה ולראות אם עדיין צריך.`, save: Math.round(onl * 0.3), links: [] });

  for (const f of ctx.fixed) {
    const a = fixedActual(ctx, f, m).amount;
    if (!a && (f.cycle || 1) === 1) checks.push(`${f.name} לא הופיע החודש`);
    else if (a && Math.abs(a - f.amount) > Math.max(5, f.amount * 0.05)) checks.push(`${f.name}: ${ils(a, 2)} במקום ${ils(f.amount, 2)}`);
  }
  tx.filter((t) => /תשלום\s*(\d+)\s*מתוך\s*\1\b/.test(t.note)).forEach((t) => checks.push(`${t.merchant}: זה התשלום האחרון, מהחודש הבא החיוב יורד`));
  checks.push(th ? "פעם בשנה כדאי לבדוק מועדי חידוש של ויזה, ביטוחים ודמי ועד של הקונדו" : "פעם בשנה כדאי לבדוק בהר הכסף אם נשכח כסף בבנקים או בפנסיה");
  return {
    status: `ב${mLabel(m)} יצאו ${ils(s.total)}: ${ils(s.fx)} קבועות ו-${ils(s.vr)} משתנות.`,
    changes: "", tips: tips.slice(0, 6), checks: checks.slice(0, 5), local: true,
  };
}

/** The text summary sent to analyze-month (same content as the prototype). */
export function monthSummaryText(ctx: Ctx, m: string): string {
  const tx = txOf(ctx, m).filter((x) => !isExcl(x));
  const s = sumM(ctx, m);
  const cats: Record<string, number> = {};
  for (const x of tx) cats[x.category] = (cats[x.category] || 0) + x.amount;
  const merch: Record<string, { n: number; a: number }> = {};
  for (const x of tx) {
    const k = x.merchant.replace(/\(.*?\)/g, "").trim();
    const o = merch[k] || (merch[k] = { n: 0, a: 0 });
    o.n++;
    o.a += x.amount;
  }
  const topM = Object.entries(merch).sort((a, b) => b[1].a - a[1].a).slice(0, 18).map(([k, v]) => `${k}: ${v.n} פעמים, ${v.a.toFixed(0)} ${baseSymbol()}`).join("\n");
  const byP: Record<string, number> = {};
  for (const x of tx) byP[personName(ctx, x.person_id)] = (byP[personName(ctx, x.person_id)] || 0) + x.amount;
  const small = tx.filter((x) => x.amount > 0 && x.amount < region().smallPurchase).length;
  const fx = ctx.fixed.map((f) => {
    const a = fixedActual(ctx, f, m).amount;
    return `${f.name}: צפוי ${f.amount}, בפועל ${a ? a.toFixed(0) : "לא הופיע"}${(f.cycle || 1) > 1 ? " (לא חודשי)" : ""}`;
  }).join("\n");
  const subs = subsOf(ctx, m).map((x) => `${x.name}: ${x.amount.toFixed(2)}`).join(", ");
  const hist = [1, 2, 3].map((i) => addM(m, -i)).map((x) => [x, sumM(ctx, x)] as const).filter((d) => d[1].total > 0).map(([x, v]) => {
    const c: Record<string, number> = {};
    for (const t of txOf(ctx, x).filter((t) => !isExcl(t))) c[t.category] = (c[t.category] || 0) + t.amount;
    return `${mLabel(x)}: סה"כ ${v.total.toFixed(0)} (קבועות ${v.fx.toFixed(0)}, משתנות ${v.vr.toFixed(0)}). לפי קטגוריה: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, a]) => k + " " + a.toFixed(0)).join(", ")}`;
  }).join("\n");
  const notes = tx.filter((x) => x.note).slice(0, 20).map((x) => `${x.merchant} ${x.amount}: ${x.note}`).join("\n");
  return `חודש: ${mLabel(m)}
בני הבית: ${activePeople(ctx).map((p) => p.name).join(", ")}
סה"כ הוצאות: ${s.total.toFixed(0)} ${baseSymbol()} (קבועות ${s.fx.toFixed(0)}, משתנות ${s.vr.toFixed(0)}), ${s.count} תנועות. הכנסות שהועלו: ${s.inc.toFixed(0)}.
לפי אדם: ${Object.entries(byP).map(([k, a]) => k + " " + a.toFixed(0)).join(", ")}
לפי קטגוריה: ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, a]) => k + " " + a.toFixed(0)).join(", ")}
בתי עסק מובילים:
${topM}
קניות קטנות (מתחת ל-${region().smallPurchase} ${baseSymbol()}): ${small}
מנויים שזוהו: ${subs || "אין"}
הוצאות קבועות מוגדרות מול בפועל:
${fx || "לא הוגדרו"}
הערות על תנועות (תשלומים, ביטולים):
${notes || "אין"}
חודשים קודמים:
${hist || "אין נתונים מחודשים קודמים"}`.slice(0, 13_500);
}

export function dupKey(t: { person_id: string | null; date: string; amount: number; merchant: string }): string {
  return [t.person_id ?? "", t.date, Number(t.amount).toFixed(2), norm(t.merchant).slice(0, 6)].join("|");
}
