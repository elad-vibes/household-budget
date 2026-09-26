// Categories, themes, auto-categorization rules and subscription patterns —
// ported verbatim from the prototype. CATS/EXCL/LINKS are shared with the
// Edge Functions through supabase/functions/_shared/catalog.ts.
export { ALLCATS, CATS, EXCL, isLinkId, LINK_IDS, LINKS } from "../../supabase/functions/_shared/catalog.ts";
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

export const RULES: [RegExp, string, boolean][] = [
  [/חיוב.*(כרטיס|אשראי)|ישראכרט|לאומי קארד|כאל |cal |מקס איט|max it|אמריקן אקספרס|דיינרס|ויזה כאל/i, "חיוב אשראי מרוכז", false],
  [/משכורת|שכר עבודה|ביטוח לאומי|קצבת|החזר מס/i, "הכנסה", false],
  [/חברת החשמל|חשמל|תאגיד|מי |מיה|מים |פז גז|פזגז|אמישראגז|סופרגז|גז |ארנונה|עיריית|ועד בית/i, "חשבונות בית", true],
  [/משכנתא|שכר דירה|שכירות/i, "דיור (שכירות/משכנתא)", true],
  [/ביטוח|הראל|מגדל|מנורה|כלל ביטוח|הפניקס|איילון|aig|איי אי ג|שומרה|ליברה|wesure/i, "ביטוחים", true],
  [/פלאפון|סלקום|פרטנר|בזק|גולן טלקום|הוט|\bhot\b|\byes\b|we4g|019|012 סמייל|רמי לוי תקשורת/i, "תקשורת ומנויים", true],
  [/netflix|נטפליקס|spotify|ספוטיפיי|disney|דיסני|apple|itunes|icloud|google|youtube|openai|chatgpt/i, "תקשורת ומנויים", false],
  [/wolt|וולט|תן ביס|10bis|סיבוס|cibus|מקדונלד|בורגר|פיצה|דומינוס|קפה|cafe|ארומה|רולדין|מסעדה|שווארמה|סושי|גלידה|בייקרי|מאפה|גונומימי/i, "אוכל בחוץ ומשלוחים", false],
  [/aliexpress|אלי אקספרס|temu|טמו|amazon|אמזון|ebay|shein|שיין|iherb/i, "קניות אונליין", false],
  // moved above the grocery rule: "סופר פארם" is a pharmacy, not "סופר "
  [/סופר.?פארם|super.?pharm|גוד פארם|good pharm|בי דראגסטורס|\bbe\b|כללית|מכבי|מאוחדת|לאומית|מרפאה|רופא|אופטיק/i, "בריאות ופארם", false],
  [/שופרסל|רמי לוי|יוחננוף|ויקטורי|טיב טעם|מגה |יינות ביתן|אושר עד|חצי חינם|קרפור|carrefour|סטריט מרקט|am:pm|אם פם|מיני מקס|פרש מרקט|סופר |מכולת|זול ובגדול|קשת טעמים/i, "סופר ומכולת", false],
  [/סונול|\bפז\b|דלק|דור אלון|\bten\b|yellow|חניון|חניה|פנגו|pango|סלופארק|cellopark|כביש 6|מוסך|רישוי/i, "רכב, דלק וחניה", false],
  [/רב.?קו|moovit|מוביט|gett|גט טקסי|רכבת|אגד|יאנגו|yango/i, "תחבורה ציבורית", false],
  [/בייבי|baby|שילב|טויס|toys|צעצוע|מעון|גן ילדים/i, "ילדים ותינוק", false],
  [/חוג|קורס|אוניברסיטה|מכללה|בית ספר|הדרכה/i, "חינוך וחוגים", false],
  [/קסטרו|castro|fox|פוקס|רנואר|h&m|zara|זארה|גולף|דלתא|terminal x|טרמינל איקס|אמריקן איגל|נעלי/i, "ביגוד והנעלה", false],
  [/איקאה|ikea|הום סנטר|אייס|ace |טמבור|מחסני חשמל|ksp|באג|עמינח/i, "בית ותחזוקה", false],
  [/סינמה|קולנוע|יס פלאנט|הופעה|תיאטרון|eventim|לאן/i, "בילויים ופנאי", false],
  [/מלון|booking|airbnb|אל על|el al|ישראייר|ארקיע|wizz|ryanair/i, "חופשות ונסיעות", false],
  [/\bbit\b|ביט|paybox|פייבוקס|משיכת מזומן|כספומט|\batm\b/i, "העברות ומזומן", false],
  [/הלוואה/i, "הלוואות", true],
  [/עמלה|דמי כרטיס|ריבית|דמי ניהול/i, "עמלות וריבית", false],
  [/פרחים|מתנה/i, "מתנות ואירועים", false],
];

export function catOf(m: string): { category: string; fixed: boolean } {
  for (const [re, c, f] of RULES) if (re.test(m)) return { category: c, fixed: f };
  return { category: "שונות", fixed: false };
}
