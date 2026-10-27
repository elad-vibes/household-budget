// Banks and card issuers per region (0016): the suggestions in the payment-method editor and the words that
// let an imported file or a receipt be matched to a method by its issuer. Names only — NO statement format
// is assumed here (see columns.ts for how a file's columns are found; a real sample of each Thai bank's export
// is still missing, DECISIONS #42).
import type { Region } from "../../supabase/functions/_shared/region.ts";

/** Israeli issuers, exactly the list the editor had before 0016. */
const IL_ISSUERS = ["מקס", "ישראכרט", "כאל", "אמריקן אקספרס", "דיינרס", "לאומי", "הפועלים", "דיסקונט", "מזרחי-טפחות", "הבינלאומי", "ירושלים", "וואן זירו", "מרכנתיל"];

/** Thai banks: the display name (≤ 30 characters, the DB limit for `issuer`) and the words that identify it in a file name,
 *  a header line or a merchant text, in Latin and Thai script. */
export const TH_BANKS: { name: string; words: RegExp }[] = [
  { name: "Kasikorn (KBank)", words: /kasikorn|k-?bank|กสิกร/i },
  { name: "SCB", words: /\bscb\b|siam commercial|ไทยพาณิชย์/i },
  { name: "Bangkok Bank", words: /bangkok bank|\bbbl\b|ธนาคารกรุงเทพ/i },
  { name: "Krungthai", words: /krungthai|krung thai|\bktb\b|กรุงไทย/i },
  { name: "Krungsri", words: /krungsri|ayudhya|\bbay\b|กรุงศรี/i },
  { name: "TMBThanachart (ttb)", words: /\bttb\b|tmbthanachart|\btmb\b|ทีทีบี|ทหารไทยธนชาต/i },
  { name: "UOB", words: /\buob\b|ยูโอบี/i },
  { name: "CIMB Thai", words: /cimb|ซีไอเอ็มบี/i },
  { name: "Government Savings Bank", words: /\bgsb\b|government savings|ออมสิน/i },
];
/** Card networks that show up as an issuer for a Thai household. */
const TH_NETWORKS = ["Visa", "Mastercard", "JCB", "American Express", "UnionPay"];
const TH_ISSUERS = [...TH_BANKS.map((b) => b.name), ...TH_NETWORKS];

/** The suggestions for the issuer field. */
export const issuersFor = (region: Region): string[] => (region === "TH" ? TH_ISSUERS : IL_ISSUERS);

/** Does this text (a file name, header lines, a merchant) point at this issuer? A Thai bank is also found by its
 *  other spellings ("KBANK" for "Kasikorn (KBank)"); everything else is a plain normalized containment. */
export function issuerInText(issuer: string, text: string, norm: (s: string) => string): boolean {
  if (!issuer.trim()) return false;
  const bank = TH_BANKS.find((b) => b.name === issuer);
  if (bank && bank.words.test(text)) return true;
  return norm(text).includes(norm(issuer));
}
