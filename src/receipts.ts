// Receipt queue: capture → compress + blur check → IndexedDB → batch send →
// poll job status → delete the image once parsed (unless kept for warranty).
import { blobToBase64, prepareImage } from "./lib/image.ts";
import { meta, queue, type QueuedReceipt } from "./lib/idb.ts";
import { uid } from "./lib/format.ts";
import { sb } from "./lib/supa.ts";
import { fn } from "./data.ts";
import { isDue } from "./domain/schedule.ts";
import { canWrite, flash, rerender, S } from "./state.ts";

const PER_CALL = 10;

export async function loadQueue() {
  S.queue = S.hh ? await queue.all(S.hh) : [];
}

async function thumbOf(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const w = 150, h = Math.round((bmp.height * w) / bmp.width);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return c.toDataURL("image/jpeg", 0.6);
}

/** Adds photos to the queue. Returns the ids that look blurry (UI asks to retake). */
export async function capture(files: File[], personId: string | null): Promise<string[]> {
  const blurry: string[] = [];
  for (const f of files) {
    const p = await prepareImage(f);
    const r: QueuedReceipt = {
      id: "r" + uid(), householdId: S.hh!, personId, blob: p.blob, thumb: await thumbOf(p.blob),
      status: "queued", jobId: null, keep: false, blur: p.blur, createdAt: Date.now(), sentAt: null, error: null,
    };
    await queue.put(r);
    if (p.blurry) blurry.push(r.id);
  }
  await loadQueue();
  return blurry;
}

export async function removeReceipt(id: string) {
  await queue.remove(id);
  await loadQueue();
}

export async function updateReceipt(id: string, patch: Partial<QueuedReceipt>) {
  const r = S.queue.find((x) => x.id === id);
  if (!r) return;
  await queue.put({ ...r, ...patch });
  await loadQueue();
}

let sending = false;
export async function sendQueued(): Promise<number> {
  if (sending || !S.hh || !canWrite()) return 0;
  const list = S.queue.filter((r) => (r.status === "queued" || r.status === "failed") && r.blob);
  if (!list.length) return 0;
  sending = true;
  S.extra.sending = true;
  rerender();
  let sent = 0;
  try {
    for (let i = 0; i < list.length; i += PER_CALL) {
      const chunk = list.slice(i, i + PER_CALL);
      const payload = await Promise.all(chunk.map(async (r) => ({
        client_id: r.id, person_id: r.personId, media_type: "image/jpeg", data: await blobToBase64(r.blob!),
      })));
      const res = await fn.receipts(payload);
      for (const r of chunk) {
        if (res.accepted.includes(r.id)) {
          await queue.put({ ...r, status: "submitted", jobId: res.job_id, sentAt: Date.now(), error: null });
          sent++;
        }
      }
    }
    await meta.set(`lastSent:${S.hh}`, Date.now());
    if (sent) flash(`✓ ${sent} קבלות נשלחו לקריאה. התוצאות יופיעו לאישור תוך כמה שעות.`, "ok");
  } catch (e: any) {
    flash(e?.message || "השליחה נכשלה. הקבלות נשארות במכשיר.", "err");
  } finally {
    sending = false;
    S.extra.sending = false;
    await loadQueue();
    rerender();
  }
  return sent;
}

/** Updates queued receipts from their server job status (parsed → delete image). */
export async function checkJobs() {
  const ids = [...new Set(S.queue.filter((r) => r.status === "submitted" && r.jobId).map((r) => r.jobId!))];
  if (!ids.length) return;
  const { data } = await sb.from("receipt_jobs").select("id, status, items").in("id", ids);
  let changed = false;
  for (const job of data ?? []) {
    if (job.status === "submitted") continue;
    for (const it of (job.items ?? []) as { client_id: string; status: string }[]) {
      const r = S.queue.find((x) => x.id === it.client_id);
      if (!r || r.status !== "submitted") continue;
      changed = true;
      if (it.status === "parsed") {
        if (r.keep) await queue.put({ ...r, status: "done" });
        else await queue.remove(r.id);   // image deleted from the device after a successful parse
      } else {
        await queue.put({ ...r, status: "failed", error: it.status === "unreadable" ? "לא הצלחנו לקרוא את הקבלה" : "הקריאה נכשלה" });
      }
    }
  }
  if (changed) await loadQueue();
}

/** "Auto-send on the first app open after the scheduled time." */
export async function maybeAutoSend() {
  if (!S.hh || !S.settings || !canWrite()) return;
  const queued = S.queue.filter((r) => r.status === "queued");
  if (!queued.length) return;
  const oldest = Math.min(...queued.map((r) => r.createdAt));
  const last = (await meta.get<number>(`lastSent:${S.hh}`)) ?? null;
  if (isDue(S.settings, oldest, last, new Date())) await sendQueued();
}
