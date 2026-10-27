// Category identity (design-brief §3): every category has a Lucide icon inside a
// soft colored circle and a color used in lists, the review table, the donut and
// its legend. Colors are dark enough for 4.5:1 on white; dark mode lightens them in CSS.
import { html, raw, type SafeHtml } from "../lib/html.ts";
import { LUCIDE } from "./lucide.ts";

export const CAT_STYLE: Record<string, { icon: string; color: string }> = {
  "סופר ומכולת": { icon: "shopping-cart", color: "#166534" },
  "אוכל בחוץ ומשלוחים": { icon: "utensils", color: "#9A3412" },
  "חשבונות בית": { icon: "zap", color: "#854D0E" },
  "דיור (שכירות/משכנתא)": { icon: "house", color: "#6B21A8" },
  "תקשורת ומנויים": { icon: "wifi", color: "#1E40AF" },
  "ביטוחים": { icon: "shield", color: "#155E75" },
  "רכב, דלק וחניה": { icon: "car", color: "#374151" },
  "תחבורה ציבורית": { icon: "bus", color: "#0F766E" },
  "בריאות ופארם": { icon: "heart-pulse", color: "#BE123C" },
  "ילדים ותינוק": { icon: "baby", color: "#A21CAF" },
  "חינוך וחוגים": { icon: "graduation-cap", color: "#4338CA" },
  "ביגוד והנעלה": { icon: "shirt", color: "#9D174D" },
  "קניות אונליין": { icon: "package", color: "#92400E" },
  "בית ותחזוקה": { icon: "wrench", color: "#57534E" },
  "בילויים ופנאי": { icon: "popcorn", color: "#6D28D9" },
  "מתנות ואירועים": { icon: "gift", color: "#BE185D" },
  "חופשות ונסיעות": { icon: "plane", color: "#0369A1" },
  "העברות ומזומן": { icon: "arrow-left-right", color: "#3F6212" },
  "הלוואות": { icon: "landmark", color: "#7F1D1D" },
  "עמלות וריבית": { icon: "percent", color: "#991B1B" },
  "ויזה ואישורי שהייה": { icon: "landmark", color: "#0E7490" },   // Thailand (0016)
  "מרכזים מסחריים": { icon: "shopping-cart", color: "#A16207" },
  "שונות": { icon: "circle-ellipsis", color: "#475569" },
  "הכנסה": { icon: "wallet", color: "#047857" },
  "חיוב אשראי מרוכז": { icon: "building-2", color: "#334155" },
  "העברה בין חשבונות": { icon: "arrow-left-right", color: "#475569" },
  "משיכת מזומן": { icon: "banknote", color: "#3F6212" },
};
const FALLBACK = CAT_STYLE["שונות"];
export const catStyle = (c: string) => CAT_STYLE[c] ?? FALLBACK;
export const catColor = (c: string) => catStyle(c).color;

/** A Lucide icon as inline SVG (decorative: aria-hidden). */
export function icon(name: string, cls = ""): SafeHtml {
  return raw(`<svg class="lu ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE[name] ?? LUCIDE["circle-ellipsis"]}</svg>`);
}

/** Category icon in a soft colored circle. */
export function catIcon(category: string, size: "s" | "m" = "m"): SafeHtml {
  const s = catStyle(category);
  return html`<span class="caticon ${size}" style="--c:${s.color}">${icon(s.icon)}</span>`;
}

/** Merchant avatar: first letter in the category color. */
export function avatar(merchant: string, category: string): SafeHtml {
  const letter = (merchant.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
  return html`<span class="avatar" style="--c:${catColor(category)}" aria-hidden="true">${letter}</span>`;
}

/** Tip icon by topic (AI analysis cards). */
export function tipIcon(title: string): SafeHtml {
  const t = title;
  const name = /חשמל/.test(t) ? "zap" : /ביטוח/.test(t) ? "shield" : /מנוי|סטרימינג|טלוויזיה/.test(t) ? "tv"
    : /תקשורת|סלולר|אינטרנט/.test(t) ? "wifi" : /סופר|מכולת/.test(t) ? "shopping-cart"
    : /אוכל|משלוח|מסעד/.test(t) ? "utensils" : /אונליין/.test(t) ? "package" : /רכב|דלק/.test(t) ? "car"
    : /חיסכון|הר הכסף/.test(t) ? "piggy-bank" : "lightbulb";
  return html`<span class="caticon m" style="--c:var(--accent-deep)">${icon(name)}</span>`;
}
