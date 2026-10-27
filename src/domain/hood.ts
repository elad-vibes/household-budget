// "השכונה שלנו" (next-features §6): the month's spending as a small neighborhood. Pure layout —
// which building each category gets, how tall it grows and which plot it stands on. The drawing
// is in ui/hood.ts. Nothing here is stored: the neighborhood is recomputed from the month's rows.
import { CATS } from "./categories.ts";

export type Kind = "house" | "shop" | "tower" | "office" | "medical" | "tree";

/** One building shape per kind of spending; the category's own color tells them apart within a kind. */
const KIND: Record<string, Kind> = {
  "דיור (שכירות/משכנתא)": "house", "חשבונות בית": "house", "בית ותחזוקה": "house", "ילדים ותינוק": "house", "חינוך וחוגים": "house",
  "סופר ומכולת": "shop", "אוכל בחוץ ומשלוחים": "shop", "ביגוד והנעלה": "shop", "קניות אונליין": "shop", "מתנות ואירועים": "shop", "בילויים ופנאי": "shop",
  "תקשורת ומנויים": "tower", "רכב, דלק וחניה": "tower", "תחבורה ציבורית": "tower", "חופשות ונסיעות": "tower",
  "ביטוחים": "office", "הלוואות": "office", "עמלות וריבית": "office", "העברות ומזומן": "office",
  "בריאות ופארם": "medical",
  "ויזה ואישורי שהייה": "office", "מרכזים מסחריים": "shop",   // Thailand (0016)
  "שונות": "tree",
};
export const kindOf = (category: string): Kind => KIND[category] ?? "tree";
export const KNOWN_KINDS = CATS.map(kindOf);

export const MAX_FLOORS = 5;
export const MAX_PLOTS = 12;
export const GRID_COLS = 4;

export interface Plot { category: string; kind: Kind; amount: number; floors: number; gx: number; gy: number }
export interface Hood { plots: Plot[]; total: number; restCount: number; restAmount: number }

/** Plots from the back of the picture (small gx+gy) to the front; the biggest spenders stand at the back so
 *  a tall building never hides a shorter one. Drawing order is the same list. */
export const SLOTS: readonly (readonly [number, number])[] = (() => {
  const all: [number, number][] = [];
  for (let gy = 0; gy < MAX_PLOTS / GRID_COLS; gy++) for (let gx = 0; gx < GRID_COLS; gx++) all.push([gx, gy]);
  return all.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
})();

/** 1…5 floors, by the square root of the share of the biggest category (so a small category is still visible). */
export const floorsFor = (amount: number, max: number) =>
  max > 0 && amount > 0 ? 1 + Math.round((MAX_FLOORS - 1) * Math.sqrt(Math.min(1, amount / max))) : 0;

export function neighborhood(spend: Record<string, number>): Hood {
  const rows = Object.entries(spend).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he"));
  const max = rows[0]?.[1] ?? 0;
  const shown = rows.slice(0, MAX_PLOTS);
  const rest = rows.slice(MAX_PLOTS);
  return {
    plots: shown.map(([category, amount], i) => ({ category, kind: kindOf(category), amount, floors: floorsFor(amount, max), gx: SLOTS[i][0], gy: SLOTS[i][1] })),
    total: rows.reduce((a, r) => a + r[1], 0),
    restCount: rest.length,
    restAmount: rest.reduce((a, r) => a + r[1], 0),
  };
}
