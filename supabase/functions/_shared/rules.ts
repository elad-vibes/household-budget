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

/**
 * Thailand (0016): merchants and statement lines as they appear on a Thai card / bank statement, in Latin and
 * Thai script. Tried BEFORE the Israeli rules for a TH household (so "7-Eleven" is groceries even though no
 * Hebrew rule knows it); anything they miss falls through to RULES, which still knows Netflix, Booking, Wolt…
 * Written from the brands' public names, not from a real statement — add a rule when a real line is missed.
 */
export const TH_RULES: [RegExp, string, boolean][] = [
  [/credit ?card (payment|bill)|card payment|pay(ment)? to .*card|ชำระ(ค่า)?บัตร(เครดิต)?|ชำระบัตร/i, "חיוב אשראי מרוכז", false],
  [/salary|payroll|เงินเดือน/i, "הכנסה", false],
  [/atm|cash withdraw|ถอนเงิน(สด)?|ถอนเงินสด/i, "משיכת מזומן", false],
  [/visa (extension|fee|service|run)|immigration|\btm ?(30|47|7|6)\b|90.?day report|re-?entry|work ?permit|\bdtv\b|ใบอนุญาตทำงาน|ตรวจคนเข้าเมือง|ต่อวีซ่า|วีซ่า(ท่องเที่ยว|ถาวร|ทำงาน)|แจ้งที่พัก/i, "ויזה ואישורי שהייה", false],
  [/\brent\b|ค่าเช่า|condo|คอนโด|juristic|นิติบุคคล|common fee|ค่าส่วนกลาง|sinking fund/i, "דיור (שכירות/משכנתא)", true],
  [/\bmea\b|\bpea\b|metropolitan electricity|provincial electricity|การไฟฟ้า|\bmwa\b|\bpwa\b|metropolitan waterworks|provincial waterworks|การประปา|ค่าไฟ|ค่าน้ำ|\bpttgas\b|ก๊าซหุงต้ม/i, "חשבונות בית", true],
  [/\bais\b|true ?(move|online|digital|corp)|\btrue\b|dtac|\b3bb\b|\bnt\b|ทรู|เอไอเอส|ดีแทค|ค่าโทรศัพท์|อินเทอร์เน็ต|internet/i, "תקשורת ומנויים", true],
  [/health insurance|life insurance|ประกัน(สุขภาพ|ชีวิต|รถ)?|\baia\b|allianz|\baxa\b|msig|bupa|cigna|muang ?thai|thai ?life|bangkok insurance|viriyah|เมืองไทย|วิริยะ|insurance/i, "ביטוחים", true],
  [/hospital|โรงพยาบาล|bumrungrad|samitivej|\bbnh\b|bangkok hospital|clinic|คลินิก|pharmacy|ร้านขายยา|\bboots\b|watsons|fascino|dental|ทันตกรรม/i, "בריאות ופארם", false],
  [/grab ?food|food ?panda|foodpanda|line ?man|lineman|robinhood|shopeefood|wongnai|เดลิเวอรี่|ฟู้ดแพนด้า|ไลน์แมน|restaurant|ร้านอาหาร|\bcafe\b|café|coffee|starbucks|amazon cafe|after you|mk (restaurant|suki)|mcdonald|\bkfc\b|burger king|pizza|\bs&p\b|fuji|sushi|bonchon|swensen|ชาบู|ก๋วยเตี๋ยว/i, "אוכל בחוץ ומשלוחים", false],
  [/7-?eleven|seven ?eleven|เซเว่น|เซเว่นอีเลฟเว่น|cp ?all|lotus'?s?|โลตัส|big ?c|บิ๊กซี|makro|แม็คโคร|tops (market|daily)?|ท็อปส์|villa market|foodland|gourmet market|\bfamily ?mart\b|แฟมิลี่มาร์ท|supermarket|ซูเปอร์มาร์เก็ต|mini ?big ?c|cj (express|more|supermarket)/i, "סופר ומכולת", false],
  [/\bgrab\b|\bbolt\b|indrive|\bbts\b|\bmrt\b|airport rail|\brabbit\b|taxi|แท็กซี่|แกร็บ|รถไฟฟ้า|\bsrt\b|ขนส่ง|songthaew|tuk ?tuk/i, "תחבורה ציבורית", false],
  [/\bptt\b|pt station|\bshell\b|bangchak|caltex|\besso\b|susco|ปตท|บางจาก|เชลล์|easy ?pass|expressway|ทางด่วน|parking|ที่จอดรถ|car ?care/i, "רכב, דלק וחניה", false],
  [/lazada|shopee|ลาซาด้า|ช้อปปี้|jd central|tiktok shop/i, "קניות אונליין", false],
  [/home ?pro|global house|thai ?watsadu|index living|ikea|ไทวัสดุ|โฮมโปร|ซ่อม|cleaning|แม่บ้าน|maid/i, "בית ותחזוקה", false],
  [/major cineplex|\bsf cinema\b|เมเจอร์|cinema|massage|นวด|\bspa\b|karaoke|bowling|muay thai|\bgym\b|fitness|ฟิตเนส/i, "בילויים ופנאי", false],
  [/thai airways|airasia|bangkok airways|nok ?air|vietjet|lion air|thai smile|agoda|traveloka|hotel|resort|โรงแรม|รีสอร์ท|การบินไทย/i, "חופשות ונסיעות", false],
  [/international school|tuition|school|โรงเรียน|ค่าเทอม|kindergarten|อนุบาล|course|คอร์ส/i, "חינוך וחוגים", false],
  [/central ?(world|festival|plaza|ladprao|westgate|embassy)?|siam ?(paragon|center|discovery)|terminal ?21|icon ?siam|emporium|emquartier|\bmbk\b|the mall|robinsons|megabangna|mega bangna|fashion island|เซ็นทรัล|พารากอน|เทอมินอล|ไอคอนสยาม|เดอะมอลล์|เมกาบางนา|เอ็มโพเรี่ยม|เอ็มควอเทียร์|สยามเซ็นเตอร์|เซ็นทรัลเวิลด์|ห้างสรรพสินค้า/i, "מרכזים מסחריים", false],
  [/promptpay|prompt pay|พร้อมเพย์|true ?money|truemoney|ทรูมันนี่|rabbit line ?pay|line ?pay|thai ?qr|qr (payment|code)|โอนเงิน|\btransfer\b|โอนไป|โอนให้/i, "העברות ומזומן", false],
  [/loan|สินเชื่อ|ผ่อน(ชำระ)?|hire purchase/i, "הלוואות", true],
  [/\bfee\b|ค่าธรรมเนียม|interest|ดอกเบี้ย|annual \bfee\b|ค่าบริการ/i, "עמלות וריבית", false],
];

export const rulesFor = (region?: string | null): [RegExp, string, boolean][] => (region === "TH" ? [...TH_RULES, ...RULES] : RULES);

/** First matching rule wins. region = the household's region ("IL" / undefined = the Israeli rules, as before 0016). */
export function catOf(m: string, region?: string | null): { category: string; fixed: boolean } {
  for (const [re, c, f] of rulesFor(region)) if (re.test(m)) return { category: c, fixed: f };
  return { category: "שונות", fixed: false };
}
