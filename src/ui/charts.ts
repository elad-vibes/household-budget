// Hand-rolled SVG charts (design-brief §4 — no chart library): category donut,
// 6-month sparkline, budget ring, savings jar. Colors come from theme tokens or
// the category palette; every chart has a text equivalent next to it.
import { raw, type SafeHtml } from "../lib/html.ts";

const f1 = (n: number) => Math.round(n * 10) / 10;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Slice { key: string; value: number; color: string }

/** Donut; each slice is tappable (data-click="cat-go") — the legend buttons are the keyboard path. */
export function donut(slices: Slice[], center: string, sub: string): SafeHtml {
  const r = 46, C = 2 * Math.PI * r;
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
  let acc = 0;
  const arcs = slices.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * C;
    const gap = slices.length > 1 ? Math.min(1.5, len / 3) : 0;
    const el = `<circle class="slice" data-click="cat-go" data-cat="${esc(s.key)}" cx="60" cy="60" r="${r}" fill="none" stroke="${s.color}" stroke-width="18"
      stroke-dasharray="${f1(Math.max(0, len - gap))} ${f1(C)}" stroke-dashoffset="${f1(-acc)}"/>`;
    acc += len;
    return el;
  }).join("");
  return raw(`<svg class="donut" viewBox="0 0 120 120" aria-hidden="true"><g transform="rotate(-90 60 60)">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="18"/>${arcs}</g>
    <text x="60" y="58" text-anchor="middle" class="dc1">${esc(center)}</text><text x="60" y="74" text-anchor="middle" class="dc2">${esc(sub)}</text></svg>`);
}

/** Small line of the last months (oldest → newest, drawn right-to-left for RTL reading). */
export function sparkline(values: number[]): SafeHtml {
  if (values.filter((v) => v > 0).length < 2) return raw("");
  const w = 120, h = 34, mx = Math.max(...values, 1);
  const pts = values.map((v, i) => [w - (i / (values.length - 1)) * w, h - 4 - (v / mx) * (h - 8)] as const);
  const line = pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(" ");
  const last = pts[pts.length - 1];
  return raw(`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${line} ${f1(pts[pts.length - 1][0])},${h} ${f1(pts[0][0])},${h}" fill="var(--accent)" opacity=".14"/>
    <polyline points="${line}" fill="none" stroke="var(--accent-deep)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${f1(last[0])}" cy="${f1(last[1])}" r="3.2" fill="var(--accent-deep)"/></svg>`);
}

/** Budget ring: accent below 80%, amber from 80%, red from 100%. */
export function ring(pct: number, level: "ok" | "warn" | "over"): SafeHtml {
  const r = 26, C = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  const color = level === "over" ? "var(--danger)" : level === "warn" ? "var(--var)" : "var(--accent)";
  return raw(`<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="7"/>
    <circle class="ring-v" cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${f1((p / 100) * C)} ${f1(C)}" transform="rotate(-90 32 32)"/>
    <text x="32" y="37" text-anchor="middle" class="rt">${Math.round(pct)}%</text></svg>`);
}

/** Savings jar that fills up with the progress. */
export function jar(pct: number, id: string): SafeHtml {
  const p = Math.max(0, Math.min(100, pct));
  const top = 30, bottom = 104, y = bottom - ((bottom - top) * p) / 100;
  const cid = "jar" + id.replace(/[^a-z0-9]/gi, "").slice(0, 12);
  return raw(`<svg class="jar" viewBox="0 0 80 112" aria-hidden="true">
    <defs><clipPath id="${cid}"><path d="M14 30h52v62a14 14 0 0 1-14 14H28a14 14 0 0 1-14-14z"/></clipPath></defs>
    <rect x="18" y="12" width="44" height="12" rx="4" fill="var(--accent-deep)"/>
    <g clip-path="url(#${cid})"><rect x="0" y="${f1(y)}" width="80" height="${f1(112 - y)}" fill="var(--accent)" class="jar-fill"/>
      <circle cx="30" cy="${f1(y + 12)}" r="5" fill="var(--var)" opacity="${p > 8 ? 1 : 0}"/><circle cx="48" cy="${f1(y + 20)}" r="5" fill="var(--var)" opacity="${p > 20 ? 1 : 0}"/></g>
    <path d="M14 30h52v62a14 14 0 0 1-14 14H28a14 14 0 0 1-14-14z" fill="none" stroke="var(--accent-deep)" stroke-width="3"/>
    <path d="M22 40v40" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".45"/></svg>`);
}
