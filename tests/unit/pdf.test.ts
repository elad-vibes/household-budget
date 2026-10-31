// Locked-PDF detection (synthetic bytes only — never a real statement).
import { describe, expect, it } from "vitest";
import { isLockedPdf, lockedPdfMessage } from "../../src/domain/pdf.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const plain = "%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF\n";
const locked = "%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 7 0 R >>\n%%EOF\n";

describe("isLockedPdf", () => {
  it("is true when the trailer points at an /Encrypt dictionary", () => {
    expect(isLockedPdf(enc(locked))).toBe(true);
  });
  it("is false for an ordinary PDF", () => {
    expect(isLockedPdf(enc(plain))).toBe(false);
  });
  it("finds the entry at the end of a large file and at the start of a linearized one", () => {
    const filler = "x".repeat(200_000);
    expect(isLockedPdf(enc("%PDF-1.5\n" + filler + "\ntrailer\n<< /Encrypt 12 0 R >>\n%%EOF"))).toBe(true);
    expect(isLockedPdf(enc("%PDF-1.5\n<< /Linearized 1 /Encrypt 3 0 R >>\n" + filler))).toBe(true);
  });
  it("ignores the word /Encrypt in the middle of a big file and anything that is not a PDF", () => {
    const filler = "x".repeat(200_000);
    expect(isLockedPdf(enc("%PDF-1.5\n" + filler + "/Encrypt 9 0 R" + filler + "\n%%EOF"))).toBe(false);
    expect(isLockedPdf(enc("PK\u0003\u0004 /Encrypt 1 0 R"))).toBe(false);
    expect(isLockedPdf(new Uint8Array())).toBe(false);
  });
  it("the message names the file and the way out", () => {
    const m = lockedPdfMessage("דף.pdf");
    expect(m).toContain("דף.pdf");
    expect(m).toContain("מוגן בסיסמה");
    expect(m).toContain("שמירה כ-PDF");
  });
});
