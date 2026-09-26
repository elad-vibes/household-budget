// Shared catalog — used by the Edge Functions AND the frontend (src/ imports it).
// Categories and the whitelisted link catalog come straight from the prototype.

export const CATS = [
  "סופר ומכולת", "אוכל בחוץ ומשלוחים", "חשבונות בית", "דיור (שכירות/משכנתא)", "תקשורת ומנויים",
  "ביטוחים", "רכב, דלק וחניה", "תחבורה ציבורית", "בריאות ופארם", "ילדים ותינוק", "חינוך וחוגים",
  "ביגוד והנעלה", "קניות אונליין", "בית ותחזוקה", "בילויים ופנאי", "מתנות ואירועים", "חופשות ונסיעות",
  "העברות ומזומן", "הלוואות", "עמלות וריבית", "שונות",
] as const;

/** Not counted as expenses. */
export const EXCL = ["הכנסה", "חיוב אשראי מרוכז", "העברה בין חשבונות", "משיכת מזומן"] as const;

export const ALLCATS: readonly string[] = [...CATS, ...EXCL];

export type LinkId =
  | "harb" | "car_calc" | "itur" | "elec_cmp" | "elec_gov" | "cell_cmp" | "comm_cmp"
  | "chp" | "pricez" | "apple_subs" | "netflix" | "disney" | "spotify";

/** The ONLY links the app ever renders from AI output. */
export const LINKS: Record<LinkId, { t: string; u: string; d: string }> = {
  harb: { t: "הר הביטוח", u: "https://harb.cma.gov.il/", d: "כל הפוליסות במקום אחד, לגלות כפל ביטוחים (משרד האוצר)" },
  car_calc: { t: "מחשבון ביטוח רכב", u: "https://car.cma.gov.il/", d: "השוואת מחירי ביטוח רכב של רשות שוק ההון" },
  itur: { t: "הר הכסף", u: "https://itur.mof.gov.il/", d: "איתור כספים שנשכחו בבנקים, בפנסיה ובביטוח" },
  elec_cmp: { t: "השוואת ספקי חשמל", u: "https://www.mishtalemli.co.il/product_cat/electricity/", d: "מסלולי הנחה של ספקי חשמל פרטיים" },
  elec_gov: { t: "רשות החשמל", u: "https://www.gov.il/he/departments/the_electricity_authority/govil-landing-page", d: "מידע רשמי על מעבר ספק חשמל" },
  cell_cmp: { t: "השוואת חבילות סלולר", u: "https://www.kamaze.co.il/compare/1/cellular", d: "כמה זה – השוואת חבילות" },
  comm_cmp: { t: "השוואת טלוויזיה ואינטרנט", u: "https://www.mishtalemli.co.il/", d: "משתלם לי – תקשורת, טלוויזיה, אינטרנט" },
  chp: { t: "CHP – השוואת סל בסופר", u: "https://chp.co.il/", d: "מחירים לפי סניפים ליד הבית" },
  pricez: { t: "פרייסז", u: "https://www.pricez.co.il/", d: "השוואת מחירי מזון ופארם" },
  apple_subs: { t: "ביטול מינוי Apple", u: "https://support.apple.com/he-il/118428", d: "איך רואים ומבטלים מינויים באייפון" },
  netflix: { t: "נטפליקס – ניהול חשבון", u: "https://www.netflix.com/YourAccount", d: "שינוי תוכנית או ביטול" },
  disney: { t: "דיסני+ – ניהול מנוי", u: "https://www.disneyplus.com/account", d: "שינוי תוכנית או ביטול" },
  spotify: { t: "ספוטיפיי – ניהול מנוי", u: "https://www.spotify.com/account/overview/", d: "שינוי תוכנית (משפחתי/זוגי) או ביטול" },
};

export const LINK_IDS = Object.keys(LINKS) as LinkId[];

export function isLinkId(x: unknown): x is LinkId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(LINKS, x);
}
