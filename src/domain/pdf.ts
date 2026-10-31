// A password-protected PDF (most bank statements are) cannot be read by anything — not by us, not by Claude's API —
// and the failure that used to come back was generic. Spotting it up front lets the app say what to do.
// The /Encrypt entry lives in the trailer (the end of the file), or near the start of a linearized file,
// so only the two ends are scanned, not the whole (up to 5 MB) document.
const ENCRYPT = /\/Encrypt\s+\d+\s+\d+\s+R/;
const EDGE = 8192;

export function isLockedPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) return false; // not "%PDF"
  const latin1 = new TextDecoder("latin1");
  return ENCRYPT.test(latin1.decode(bytes.subarray(0, EDGE))) || ENCRYPT.test(latin1.decode(bytes.subarray(Math.max(0, bytes.length - EDGE))));
}

/** What to tell a person whose PDF is locked: one line, then the way out. */
export const lockedPdfMessage = (name: string) =>
  `${name}: הקובץ מוגן בסיסמה, ולכן אי אפשר לקרוא אותו. פותחים אותו בדפדפן עם הסיסמה, בוחרים הדפסה ← שמירה כ-PDF, ומעלים את העותק החדש (בלי סיסמה).`;
