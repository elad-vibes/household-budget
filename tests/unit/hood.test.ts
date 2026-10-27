// "השכונה שלנו" (§6): layout rules of the neighborhood and the markup of its picture.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CATS } from "../../src/domain/categories.ts";
import { floorsFor, kindOf, KNOWN_KINDS, MAX_FLOORS, MAX_PLOTS, neighborhood, SLOTS } from "../../src/domain/hood.ts";
import { hoodSvg } from "../../src/ui/hood.ts";

describe("neighborhood layout", () => {
  it("every expense category has a building kind; unknown ones become trees", () => {
    expect(KNOWN_KINDS).toHaveLength(CATS.length);
    expect(new Set(KNOWN_KINDS).size).toBeGreaterThanOrEqual(5);
    expect(kindOf("קטגוריה שלא קיימת")).toBe("tree");
  });

  it("height grows with spend, from 1 to 5 floors, and the biggest category is the tallest", () => {
    expect(floorsFor(1000, 1000)).toBe(MAX_FLOORS);
    expect(floorsFor(1, 1000)).toBe(1 + Math.round((MAX_FLOORS - 1) * Math.sqrt(0.001)));
    expect(floorsFor(0, 1000)).toBe(0);
    expect(floorsFor(-5, 1000)).toBe(0);
    expect(floorsFor(10, 0)).toBe(0);
    const h = neighborhood({ "סופר ומכולת": 4000, "בריאות ופארם": 1000, "שונות": 100 });
    expect(h.plots.map((p) => p.floors)).toEqual([5, 3, 2]);
    expect(h.plots.map((p) => p.category)).toEqual(["סופר ומכולת", "בריאות ופארם", "שונות"]);
  });

  it("ignores zero and negative spend; empty month has no buildings", () => {
    expect(neighborhood({}).plots).toEqual([]);
    const h = neighborhood({ "סופר ומכולת": 0, "ביטוחים": -50, "רכב, דלק וחניה": 300 });
    expect(h.plots.map((p) => p.category)).toEqual(["רכב, דלק וחניה"]);
    expect(h.total).toBe(300);
  });

  it("at most 12 plots, each on its own slot, biggest at the back; the rest are counted", () => {
    const spend: Record<string, number> = {};
    CATS.forEach((c, i) => { spend[c] = 100 + i * 10; });
    const h = neighborhood(spend);
    expect(h.plots).toHaveLength(MAX_PLOTS);
    expect(h.restCount).toBe(CATS.length - MAX_PLOTS);
    expect(h.restAmount).toBe(Object.values(spend).sort((a, b) => b - a).slice(MAX_PLOTS).reduce((a, b) => a + b, 0));
    expect(new Set(h.plots.map((p) => `${p.gx},${p.gy}`)).size).toBe(MAX_PLOTS);
    expect(SLOTS[0]).toEqual([0, 0]);
    const depth = h.plots.map((p) => p.gx + p.gy);
    expect(depth).toEqual([...depth].sort((a, b) => a - b));
  });

  it("is deterministic: same spend, same plots and same markup", () => {
    const s = { "סופר ומכולת": 900, "ביטוחים": 400, "שונות": 80 };
    expect(neighborhood(s)).toEqual(neighborhood({ ...s }));
    expect(hoodSvg(neighborhood(s), "x").toString()).toBe(hoodSvg(neighborhood(s), "x").toString());
  });
});

describe("neighborhood picture", () => {
  const svg = (s: Record<string, number>, label = "שכונה") => hoodSvg(neighborhood(s), label).toString();

  it("one tappable group per building, themed only through CSS classes and the category color", () => {
    const out = svg({ "סופר ומכולת": 900, "בריאות ופארם": 400, "דיור (שכירות/משכנתא)": 700, "תקשורת ומנויים": 200, "שונות": 50 });
    expect(out.match(/class="hb-b"/g)).toHaveLength(5);
    expect(out.match(/data-click="cat-go"/g)).toHaveLength(5);
    expect(out).toContain('role="img"');
    expect(out).not.toMatch(/fill="#|fill="rgb|style="fill/); // colors come from design.css, so dark mode can recolor
    expect(out).not.toMatch(/<script|on\w+=/i);
  });

  it("escapes the label and category names", () => {
    const out = svg({ 'x"><script>': 100 }, '"><img src=x>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
  });

  it("stays small: a full 12-building neighborhood gzips to under 5 KB (budget for the whole feature: 15 KB gz)", () => {
    const spend: Record<string, number> = {};
    CATS.forEach((c, i) => { spend[c] = 100 + i * 50; });
    expect(gzipSync(svg(spend)).length).toBeLessThan(5_000);
  });
});
