// Auto-categorization rules (from the prototype). Shared by the app (src/domain/categories.ts
// re-exports them) and the capture Edge Function. Order matters: first match wins.

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
  // ATM = money moved to cash, not an expense (payment-methods.md); bit/PayBox stay transfers
  [/משיכת מזומן|משיכה מכספומט|כספומט|\batm\b/i, "משיכת מזומן", false],
  [/\bbit\b|ביט|paybox|פייבוקס/i, "העברות ומזומן", false],
  [/הלוואה/i, "הלוואות", true],
  [/עמלה|דמי כרטיס|ריבית|דמי ניהול/i, "עמלות וריבית", false],
  [/פרחים|מתנה/i, "מתנות ואירועים", false],
];

export function catOf(m: string): { category: string; fixed: boolean } {
  for (const [re, c, f] of RULES) if (re.test(m)) return { category: c, fixed: f };
  return { category: "שונות", fixed: false };
}
