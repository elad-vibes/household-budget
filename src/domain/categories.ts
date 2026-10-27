// Categories, themes, auto-categorization rules and subscription patterns —
// ported verbatim from the prototype. CATS/EXCL/LINKS are shared with the
// Edge Functions through supabase/functions/_shared/catalog.ts.
export { ALLCATS, CATS, catsFor, EXCL, isKnownCat, isLinkId, LINK_IDS, LINKS, TH_CATS } from "../../supabase/functions/_shared/catalog.ts";
export type { LinkId } from "../../supabase/functions/_shared/catalog.ts";

export interface Theme { label: string; accent: string; deep: string; soft: string; ground: string; var: string }

export const THEMES: Record<string, Theme> = {
  max: { label: "מקס", accent: "#00A58E", deep: "#00705F", soft: "#E0F5F1", ground: "#F4FAF8", var: "#E39B2D" },
  isracard: { label: "ישראכרט", accent: "#1F5BB8", deep: "#163F80", soft: "#E5EDF9", ground: "#F5F8FC", var: "#E39B2D" },
  cal: { label: "כאל", accent: "#5B46B5", deep: "#3F2F85", soft: "#ECE8F8", ground: "#F7F6FC", var: "#E39B2D" },
  leumi: { label: "לאומי", accent: "#0A84C6", deep: "#075E8E", soft: "#E2F1FA", ground: "#F4F9FC", var: "#E39B2D" },
  hapoalim: { label: "הפועלים", accent: "#D4273A", deep: "#9C1A28", soft: "#FBE6E8", ground: "#FCF6F6", var: "#3C7FC0" },
  discount: { label: "דיסקונט", accent: "#2E9B47", deep: "#1F6E32", soft: "#E3F4E7", ground: "#F5FAF6", var: "#E39B2D" },
  mizrahi: { label: "מזרחי-טפחות", accent: "#EE7A1F", deep: "#A9530F", soft: "#FDEEDF", ground: "#FDF8F3", var: "#3C7FC0" },
  neutral: { label: "ניטרלי", accent: "#3E6B78", deep: "#2B4C56", soft: "#E6EFF1", ground: "#F5F7F7", var: "#D9942E" },
};

export const PCOLORS = ["accent", "#7B68D9", "#E07A5F", "#3BA3C7", "#B99A2E", "#C25FA0", "#5E9E6E"];

export const SUBS: [string, RegExp, string[]][] = [
  ["נטפליקס", /netflix|נטפליקס/i, ["netflix"]], ["דיסני+", /disney|דיסני/i, ["disney"]],
  ["ספוטיפיי", /spotify|ספוטיפיי/i, ["spotify"]], ["Apple", /apple|itunes|icloud|אפל/i, ["apple_subs"]],
  ["יוטיוב", /youtube|יוטיוב/i, []], ["אמזון פריים", /amazon prime|prime video|אמזון/i, []], ["HBO", /\bhbo\b/i, []],
  ["גוגל", /google|גוגל/i, []], ["סטינג", /sting|סטינג/i, ["comm_cmp"]], ["YES", /\byes\b/i, ["comm_cmp"]],
  ["HOT", /\bhot\b|הוט/i, ["comm_cmp"]], ["פרטנר TV", /partner ?tv|פרטנר טי/i, ["comm_cmp"]],
  ["סלקום TV", /cellcom ?tv|סלקום טי/i, ["comm_cmp"]], ["ChatGPT", /openai|chatgpt/i, []], ["Claude", /anthropic|claude/i, []],
];

export { catOf, RULES, rulesFor, TH_RULES } from "../../supabase/functions/_shared/rules.ts";
