// Month math, fixed-expense matching, tips, schedule, blur detection,
// auto-escaping templates, backups and the IndexedDB queue.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { dupKey, fixedStatus, isFixed, localTips, monthSummaryText, personName, subsOf, sumM, type Ctx } from "../../src/domain/calc.ts";
import { describeNext, isDue, lastScheduled, nextScheduled } from "../../src/domain/schedule.ts";
import { laplacianVariance, BLUR_THRESHOLD } from "../../src/lib/image.ts";
import { html, raw, safeUrl } from "../../src/lib/html.ts";
import { addM, ils } from "../../src/lib/format.ts";
import { exportV2, parseBackup, planImport } from "../../src/domain/backup.ts";
import { queue, meta } from "../../src/lib/idb.ts";
import type { Fixed, Person, Tx } from "../../src/domain/types.ts";

const HH = "hh";
const people: Person[] = [
  { id: "p1", household_id: HH, name: "דנה", user_id: "u1", sort: 1, archived: false, legacy_key: null },
  { id: "p2", household_id: HH, name: "יואב", user_id: null, sort: 2, archived: false, legacy_key: "p2" },
];
let n = 0;
const tx = (month: string, merchant: string, amount: number, category: string, over: Partial<Tx> = {}): Tx => ({
  id: `t${++n}`, household_id: HH, date: `${month}-10`, month, merchant, amount, category, is_fixed: false, note: "",
  person_id: "p1", source: "manual", source_title: "", status: "saved", ...over,
});
const fixed: Fixed[] = [
  { id: "f1", household_id: HH, name: "ביטוח בריאות", amount: 89, keyword: "הראל", category: "ביטוחים", person_id: null, cycle: 1, due_day: 5, note: "" },
  { id: "f2", household_id: HH, name: "ביטוח רכב", amount: 2400, keyword: "ביטוח ישיר", category: "ביטוחים", person_id: null, cycle: 12, due_day: null, note: "" },
];
const ctx: Ctx = {
  people, fixed,
  tx: [
    tx("2026-08", "הראל ביטוח", 89, "ביטוחים"),
    tx("2026-08", "שופרסל", 820, "סופר ומכולת"),
    tx("2026-08", "חברת החשמל", 410, "חשבונות בית", { is_fixed: true }),
    tx("2026-08", "נטפליקס", 54.9, "תקשורת ומנויים", { person_id: null }),
    tx("2026-08", "משכורת", 12000, "הכנסה"),
    tx("2026-08", "חיוב ישראכרט", 3000, "חיוב אשראי מרוכז"),
    tx("2026-08", "קבלה בבדיקה", 99, "שונות", { status: "review" }),
    tx("2026-07", "שופרסל", 700, "סופר ומכולת"),
  ],
};

describe("month totals", () => {
  it("splits fixed vs variable, excludes income/card lump sums and unapproved receipts", () => {
    const s = sumM(ctx, "2026-08");
    expect(s.fx).toBeCloseTo(89 + 410, 2);
    expect(s.vr).toBeCloseTo(820 + 54.9, 2);
    expect(s.total).toBeCloseTo(1373.9, 2);
    expect(s.inc).toBe(12000);
    expect(s.count).toBe(4);
  });
  it("matches fixed expenses by keyword", () => {
    expect(isFixed(ctx, ctx.tx[0])).toBe(true);
    expect(isFixed(ctx, ctx.tx[1])).toBe(false);
    expect(fixedStatus(ctx, fixed[0], "2026-08").kind).toBe("ok");
    expect(fixedStatus(ctx, fixed[0], "2026-07").kind).toBe("miss");
    expect(fixedStatus(ctx, fixed[1], "2026-08").kind).toBe("notthis");
  });
  it("finds subscriptions and names people", () => {
    expect(subsOf(ctx, "2026-08").map((x) => x.name)).toEqual(["נטפליקס"]);
    expect(personName(ctx, null)).toBe("משותף");
    expect(personName(ctx, "p2")).toBe("יואב");
  });
  it("rule-based tips and the summary text", () => {
    const t = localTips(ctx, "2026-08")!;
    expect(t.local).toBe(true);
    expect(t.tips.map((x) => x.title)).toContain("לבדוק ספק חשמל פרטי");
    expect(t.status).toContain("אוגוסט 2026");
    const sum = monthSummaryText(ctx, "2026-08");
    expect(sum).toContain("בני הבית: דנה, יואב");
    expect(sum).toContain("יולי 2026");
    expect(sum).not.toContain("קבלה בבדיקה");
  });
  it("dupKey is stable", () => {
    expect(dupKey({ person_id: null, date: "2026-08-10", amount: 10, merchant: "Shufersal Deal" }))
      .toBe(dupKey({ person_id: null, date: "2026-08-10", amount: 10.0, merchant: "shufersal-deal" }));
  });
  it("formats money and months", () => {
    expect(ils(1234.5, 2)).toBe("₪1,234.50");
    expect(addM("2026-01", -1)).toBe("2025-12");
    expect(addM("2026-12", 1)).toBe("2027-01");
  });
});

describe("receipt send schedule", () => {
  const weekly = { send_mode: "weekly" as const, send_weekday: 0, send_monthday: 1 };  // Sunday
  const monthly = { send_mode: "monthly" as const, send_weekday: 0, send_monthday: 10 };
  const wed = new Date(2026, 8, 23, 12); // Wed 23 Sep 2026
  it("weekly: last/next Sunday", () => {
    expect(lastScheduled(weekly, wed)!.getDate()).toBe(20);
    expect(nextScheduled(weekly, wed)!.getDate()).toBe(27);
    expect(describeNext(weekly, wed)).toBe("השליחה הבאה: יום ראשון");
  });
  it("sends on the first open after the scheduled time, once", () => {
    const capturedMon = new Date(2026, 8, 21).getTime();
    expect(isDue(weekly, capturedMon, null, wed)).toBe(false);            // next Sunday hasn't come
    const mon28 = new Date(2026, 8, 28, 9);
    expect(isDue(weekly, capturedMon, null, mon28)).toBe(true);           // opened after Sunday 27
    expect(isDue(weekly, capturedMon, mon28.getTime(), new Date(2026, 8, 29))).toBe(false); // already sent
    expect(isDue(weekly, null, null, mon28)).toBe(false);                 // nothing queued
  });
  it("monthly and immediate", () => {
    expect(lastScheduled(monthly, wed)!.getDate()).toBe(10);
    expect(lastScheduled(monthly, new Date(2026, 8, 5))!.getMonth()).toBe(7); // Aug 10
    expect(isDue({ ...monthly, send_mode: "immediate" }, Date.now(), null, new Date())).toBe(true);
  });
});

describe("blur detection (Laplacian variance)", () => {
  const W = 120, H = 80;
  const sharp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sharp[y * W + x] = (Math.floor(x / 3) + Math.floor(y / 5)) % 2 ? 230 : 20;
  const blurred = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, c = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx));
      s += sharp[yy * W + xx]; c++;
    }
    blurred[y * W + x] = s / c;
  }
  it("sharp text-like edges score high, a blurred copy scores low", () => {
    expect(laplacianVariance(sharp, W, H)).toBeGreaterThan(BLUR_THRESHOLD * 10);
    expect(laplacianVariance(blurred, W, H)).toBeLessThan(BLUR_THRESHOLD);
    expect(laplacianVariance(new Float32Array(W * H).fill(128), W, H)).toBe(0);
  });
});

describe("html templates escape by default", () => {
  it("escapes values but keeps nested templates", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const out = html`<b>${evil}</b>${[html`<i>${"a&b"}</i>`]}${raw("<hr>")}`.toString();
    expect(out).toBe("<b>&lt;img src=x onerror=alert(1)&gt;</b><i>a&amp;b</i><hr>");
  });
  it("only allows https links", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("https://harb.cma.gov.il/")).toBe("https://harb.cma.gov.il/");
  });
});

describe("backups", () => {
  const v1 = {
    v: 1,
    batches: [
      { person: "p1", source: "פירוט מקס", items: [
        { date: "2026-08-03", month: "2026-08", merchant: "סופר", amount: 100, category: "סופר ומכולת", fixed: false, note: "", person: "p1" },
        { date: "2026-08-04", month: "2026-08", merchant: "גן", amount: 1500, category: "ילדים ותינוק", fixed: true, note: "", person: "p9" },
        { date: "2026-08-05", month: "2026-08", merchant: "x", amount: 0, category: "שונות" },
      ] },
    ],
    fixed: [{ id: "f", name: "ארנונה", amount: 610, keyword: "עיריית", category: "חשבונות בית", person: "any", cycle: 2 }],
    settings: { people: [{ id: "p1", name: "דנה" }, { id: "p9", name: "נועה" }], theme: "cal" },
    shop: [{ id: "s", name: "חלב", qty: 2, done: false }],
    analyses: { "2026-08": { data: { status: "סיכום", tips: [], checks: [] } } },
  };
  it("reads the prototype format (hb-data-v1)", () => {
    const b = parseBackup(v1);
    expect(b.version).toBe(1);
    expect(b.tx).toHaveLength(2);
    expect(b.tx[1].personKey).toBe("p9");
    expect(b.fixed[0]).toMatchObject({ personKey: null, cycle: 2 });
    expect(b.theme).toBe("cal");
    expect(b.analyses[0].month).toBe("2026-08");
  });
  it("maps people by name, creates the missing ones, skips duplicates", () => {
    const b = parseBackup(v1);
    const existingTx = [tx("2026-08", "סופר", 100, "סופר ומכולת", { date: "2026-08-03", person_id: "p1" })];
    const plan = planImport(b, people, existingTx);
    expect(plan.personMap.p1).toBe("p1");            // matched "דנה" by name
    expect(plan.newPeople.map((p) => p.name)).toEqual(["נועה"]);
    expect(plan.tx).toHaveLength(1);
    expect(plan.skippedDup).toBe(1);
  });
  it("rejects files that are not backups", () => {
    expect(() => parseBackup({ hello: 1 })).toThrow(/גיבוי/);
  });
  it("round-trips the v2 export", () => {
    const out = exportV2({ householdName: "בית", people, tx: ctx.tx, fixed, shop: [], analyses: [], theme: "max" });
    expect(out.transactions.some((t) => t.merchant === "קבלה בבדיקה")).toBe(false);
    const back = parseBackup(JSON.parse(JSON.stringify(out)));
    expect(back.version).toBe(2);
    expect(back.tx.length).toBe(out.transactions.length);
  });
});

describe("IndexedDB receipt queue", () => {
  it("stores receipts per household and meta values", async () => {
    await queue.put({ id: "r1", householdId: "A", personId: null, blob: new Blob(["x"]), thumb: "", status: "queued", jobId: null, keep: false, blur: 100, createdAt: 2, sentAt: null, error: null });
    await queue.put({ id: "r2", householdId: "B", personId: null, blob: null, thumb: "", status: "queued", jobId: null, keep: false, blur: 100, createdAt: 1, sentAt: null, error: null });
    expect((await queue.all("A")).map((r) => r.id)).toEqual(["r1"]);
    await queue.remove("r1");
    expect(await queue.all("A")).toEqual([]);
    await meta.set("lastSent:A", 123);
    expect(await meta.get("lastSent:A")).toBe(123);
  });
});
