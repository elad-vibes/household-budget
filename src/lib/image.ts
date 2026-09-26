// On-device image handling for receipts and statement photos:
//   * compress to ~1.2MP JPEG (receipts) — small uploads, enough for OCR
//   * blur check: variance of the Laplacian on a downscaled grayscale copy.
//     Sharp text has strong edges (high variance); a shaky photo does not.

export const RECEIPT_MAX_PIXELS = 1_200_000;
export const STATEMENT_MAX_PIXELS = 2_400_000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Below this the photo is probably too blurry to read (tuned on 480px-wide copies). */
export const BLUR_THRESHOLD = 60;

/** Variance of the 4-neighbour Laplacian over a grayscale image. */
export function laplacianVariance(gray: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function toGray(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return g;
}

function canvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function toBlob(c: HTMLCanvasElement | OffscreenCanvas, quality: number): Promise<Blob> {
  if ("convertToBlob" in c) return c.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", quality));
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

export interface Prepared { blob: Blob; width: number; height: number; blur: number; blurry: boolean }

export async function prepareImage(file: Blob, maxPixels = RECEIPT_MAX_PIXELS, quality = 0.82): Promise<Prepared> {
  const bmp = await decode(file);
  const scale = Math.min(1, Math.sqrt(maxPixels / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = canvas(w, h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0, w, h);

  // blur check on a ~480px-wide copy
  const bw = Math.min(480, w), bh = Math.max(3, Math.round((h * bw) / w));
  const small = canvas(bw, bh);
  const sctx = small.getContext("2d") as CanvasRenderingContext2D;
  sctx.drawImage(bmp, 0, 0, bw, bh);
  const data = sctx.getImageData(0, 0, bw, bh).data;
  const blur = laplacianVariance(toGray(data, bw, bh), bw, bh);
  bmp.close?.();

  let q = quality;
  let blob = await toBlob(c, q);
  while (blob.size > MAX_UPLOAD_BYTES && q > 0.4) {
    q -= 0.15;
    blob = await toBlob(c, q);
  }
  return { blob, width: w, height: h, blur: Math.round(blur), blurry: blur < BLUR_THRESHOLD };
}

export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
