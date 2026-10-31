// Validates uploaded files: declared mime type, real magic bytes, decoded size.
import { LIMITS } from "./config.ts";
import { HttpError } from "./http.ts";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PDF_TYPE = "application/pdf";
export type ImageType = (typeof IMAGE_TYPES)[number];

export interface CheckedFile {
  media_type: ImageType | typeof PDF_TYPE;
  data: string; // base64, no data: prefix, no whitespace
  bytes: number;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodedLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

function head(b64: string): Uint8Array {
  const bin = atob(b64.slice(0, 24));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return PDF_TYPE;
  return null;
}

// A password-protected PDF names an /Encrypt dictionary in its trailer (end of file; start of a linearized one).
// Same rule as src/domain/pdf.ts — the edge functions cannot import from src. Base64 slices stay aligned: 4 chars = 3 bytes.
const ENCRYPT = /\/Encrypt\s+\d+\s+\d+\s+R/;
function isLockedPdf(b64: string): boolean {
  const edge = 4 * Math.ceil(8192 / 3);
  const text = (s: string) => atob(s.slice(0, s.length - (s.length % 4)));
  return ENCRYPT.test(text(b64.slice(0, edge))) || ENCRYPT.test(text(b64.slice(-edge)));
}

export function checkFile(input: unknown, allowed: readonly string[]): CheckedFile {
  const f = input as { media_type?: unknown; data?: unknown } | null;
  if (!f || typeof f.media_type !== "string" || typeof f.data !== "string") {
    throw new HttpError(400, "bad_file", "אחד הקבצים לא תקין.");
  }
  if (!allowed.includes(f.media_type)) {
    throw new HttpError(415, "bad_type", "סוג קובץ לא נתמך. אפשר תמונה (JPG, PNG, WEBP) או PDF.");
  }
  const data = f.data.replace(/^data:[^,]*,/, "");
  if (data.length < 32 || !B64.test(data)) throw new HttpError(400, "bad_file", "אחד הקבצים לא תקין.");
  const bytes = decodedLength(data);
  if (bytes > LIMITS.maxFileBytes) {
    throw new HttpError(413, "file_too_large", "אחד הקבצים גדול מ-5MB. אפשר לצלם שוב או לשלוח צילום מסך.");
  }
  const real = sniff(head(data));
  if (real !== f.media_type) throw new HttpError(415, "type_mismatch", "תוכן הקובץ לא תואם לסוג שלו.");
  if (real === PDF_TYPE && isLockedPdf(data)) {
    throw new HttpError(422, "pdf_locked", "הקובץ מוגן בסיסמה, ולכן אי אפשר לקרוא אותו. פותחים אותו בדפדפן עם הסיסמה, בוחרים הדפסה ← שמירה כ-PDF, ומעלים את העותק החדש.");
  }
  return { media_type: f.media_type as CheckedFile["media_type"], data, bytes };
}
