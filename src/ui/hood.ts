// "השכונה שלנו" (next-features §6): hand-drawn isometric SVG, one building per category (shape by kind of
// spending, color = the category's own, height = spend). Faces take their shades from CSS (design.css .hb-*),
// so light/dark and every theme recolor it. Decorative image + a text line and tappable legend carry the meaning.
import { html, raw, type SafeHtml } from "../lib/html.ts";
import { ils, mLabel } from "../lib/format.ts";
import { isExcl, txOf } from "../domain/calc.ts";
import { neighborhood, type Hood, type Plot } from "../domain/hood.ts";
import { ctx } from "../state.ts";
import { currentBudgetMonth } from "../domain/month.ts";
import { catColor } from "./cat.ts";

const TW = 44, TH = 22, FH = 9, K = 0.72; // tile size, floor height, footprint share of the tile
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (p: [number, number][]) => p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");

/** A window on a side face: t along the bottom edge (0…1), floor index. */
function win(a: [number, number], b: [number, number], t: number, fl: number): string {
  const w = 0.2, y0 = 2 + fl * FH, h = 4.2;
  const p = (u: number, dy: number): [number, number] => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - dy];
  return `<polygon class="hb-w" points="${pts([p(t, y0), p(t + w, y0), p(t + w, y0 + h), p(t, y0 + h)])}"/>`;
}

function building(p: Plot): string {
  const cx = (p.gx - p.gy) * TW / 2, cy = (p.gx + p.gy) * TH / 2;
  const a = TW / 2 * K, b = TH / 2 * K;
  const top: [number, number] = [cx, cy - b], rgt: [number, number] = [cx + a, cy], bot: [number, number] = [cx, cy + b], lft: [number, number] = [cx - a, cy];
  const ground = `<polygon class="hb-g" points="${pts([[cx, cy - TH / 2], [cx + TW / 2, cy], [cx, cy + TH / 2], [cx - TW / 2, cy]])}"/>`;
  const c = esc(p.category);
  const open = `<g class="hb-b" data-click="cat-go" data-cat="${c}" style="--c:${catColor(p.category)}"><title>${c}</title>${ground}`;
  if (p.kind === "tree") {
    const h = 6 + p.floors * 5, r = 5 + p.floors * 1.6;
    return `${open}<rect class="hb-t" x="${r1(cx - 1.6)}" y="${r1(cy - h)}" width="3.2" height="${r1(h)}" rx="1"/>
      <ellipse class="hb-top" cx="${r1(cx)}" cy="${r1(cy - h - r * 0.4)}" rx="${r1(r)}" ry="${r1(r * 0.85)}"/><ellipse class="hb-l" cx="${r1(cx - r * 0.3)}" cy="${r1(cy - h - r * 0.2)}" rx="${r1(r * 0.55)}" ry="${r1(r * 0.5)}"/></g>`;
  }
  const H = p.floors * FH;
  const up = (q: [number, number], d = H): [number, number] => [q[0], q[1] - d];
  let s = `${open}<polygon class="hb-l" points="${pts([lft, bot, up(bot), up(lft)])}"/><polygon class="hb-r" points="${pts([bot, rgt, up(rgt), up(bot)])}"/>`;
  for (let f = 0; f < p.floors; f++) s += win(lft, bot, 0.18, f) + win(lft, bot, 0.58, f) + win(bot, rgt, 0.18, f) + win(bot, rgt, 0.58, f);
  if (p.kind === "house") {
    // gable roof: the ridge runs between the middles of the back-left and front-right edges
    const mid = (q: [number, number], w: [number, number]): [number, number] => [(q[0] + w[0]) / 2, (q[1] + w[1]) / 2 - H - 8];
    const m1 = mid(lft, top), m2 = mid(bot, rgt);
    s += `<polygon class="hb-r hb-roof" points="${pts([up(top), up(rgt), m2, m1])}"/><polygon class="hb-l hb-roof" points="${pts([up(lft), up(bot), m2, m1])}"/><polygon class="hb-r hb-roof2" points="${pts([up(bot), up(rgt), m2])}"/>`;
  } else {
    s += `<polygon class="hb-top" points="${pts([up(top), up(rgt), up(bot), up(lft)])}"/>`;
    if (p.kind === "tower") s += `<path class="hb-ant" d="M${r1(cx)} ${r1(cy - H)}V${r1(cy - H - 10)}"/><circle class="hb-dot" cx="${r1(cx)}" cy="${r1(cy - H - 10)}" r="1.6"/>`;
    else if (p.kind === "shop") s += `<polygon class="hb-awn" points="${pts([lft, bot, [bot[0], bot[1] - 3.5], [lft[0], lft[1] - 3.5]])}"/><polygon class="hb-awn hb-awn2" points="${pts([bot, rgt, [rgt[0], rgt[1] - 3.5], [bot[0], bot[1] - 3.5]])}"/>`;
    else if (p.kind === "medical") s += `<path class="hb-cross" d="M${r1(cx)} ${r1(cy - H - 5)}v-6M${r1(cx - 3)} ${r1(cy - H - 8)}h6"/>`;
    else s += `<polygon class="hb-par" points="${pts([up(top, H + 2.5), up(rgt, H + 2.5), up(bot, H + 2.5), up(lft, H + 2.5)])}"/>`;
  }
  return `${s}</g>`;
}

/** Just the picture. Same plots → same markup (no randomness). */
export function hoodSvg(h: Hood, label: string): SafeHtml {
  // plots span x -66…88; the picture ends under the front-most plot, so a small neighborhood isn't padded with air
  const bottom = Math.max(0, ...h.plots.map((p) => ((p.gx + p.gy) * TH) / 2)) + TH / 2 + 4;
  return raw(`<svg class="hood" viewBox="-70 -66 164 ${r1(bottom + 66)}" role="img" aria-label="${esc(label)}" focusable="false">
    ${h.plots.map(building).join("")}</svg>`);
}

/** The overview card; for a finished budget month it is the month-end summary. */
export function hoodCard(m: string): SafeHtml {
  const c = ctx();
  const spend: Record<string, number> = {};
  for (const x of txOf(c, m)) if (!isExcl(x)) spend[x.category] = (spend[x.category] || 0) + x.amount;
  const h = neighborhood(spend);
  if (!h.plots.length) return html``;
  const done = m < currentBudgetMonth(c.startDay);
  const top = h.plots[0];
  const label = `השכונה של ${mLabel(m)}: ${h.plots.length} בניינים. הגבוה ביותר: ${top.category}, ${ils(top.amount)}.`;
  return html`<div class="card hoodcard"><div class="card-h"><h2>${done ? `השכונה של ${mLabel(m)}` : "השכונה שלנו"}</h2><span class="muted small">${done ? "סיכום החודש" : "גדלה עם כל הוצאה"}</span></div>
    ${hoodSvg(h, label)}
    <p class="small">${done ? "החודש נסגר עם" : "עד עכשיו"} ${h.plots.length} בניינים${h.restCount ? ` ועוד ${h.restCount} קטנים` : ""}. הגבוה ביותר הוא <b>${top.category}</b> (${ils(top.amount)}, ${Math.round((top.amount / (h.total || 1)) * 100)}% מההוצאות).</p>
    <div class="hoodleg">${h.plots.slice(0, 6).map((p) => html`<button data-click="cat-go" data-cat="${p.category}"><i class="dot" style="background:${catColor(p.category)}"></i><span class="nm">${p.category}</span><b class="num">${ils(p.amount)}</b></button>`)}</div>
  </div>`;
}
