// When do queued receipts get sent? Household setting "send mode":
//   immediate — as soon as they are captured
//   weekly    — on a chosen weekday (00:00 local time)
//   monthly   — on a chosen day of the month (1–28, 00:00 local time)
// Auto-send happens on the first app open after the scheduled time.
import { HEB_D } from "../lib/format.ts";

export interface SendSettings { send_mode: "immediate" | "weekly" | "monthly"; send_weekday: number; send_monthday: number }

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Most recent scheduled moment at or before `now` (null for immediate). */
export function lastScheduled(s: SendSettings, now: Date): Date | null {
  if (s.send_mode === "immediate") return null;
  if (s.send_mode === "weekly") {
    const d = startOfDay(now);
    const back = (d.getDay() - s.send_weekday + 7) % 7;
    d.setDate(d.getDate() - back);
    return d;
  }
  const day = Math.min(Math.max(1, s.send_monthday), 28);
  let d = new Date(now.getFullYear(), now.getMonth(), day);
  if (d > now) d = new Date(now.getFullYear(), now.getMonth() - 1, day);
  return d;
}

/** Next scheduled moment strictly after `now`. */
export function nextScheduled(s: SendSettings, now: Date): Date | null {
  if (s.send_mode === "immediate") return null;
  const last = lastScheduled(s, now)!;
  const d = new Date(last);
  if (s.send_mode === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Should the queue be sent now? True when a scheduled moment passed after the
 * oldest queued receipt was captured and after the last send from this device.
 */
export function isDue(s: SendSettings, oldestQueuedAt: number | null, lastSentAt: number | null, now: Date): boolean {
  if (oldestQueuedAt === null) return false;
  if (s.send_mode === "immediate") return true;
  const t = lastScheduled(s, now)!.getTime();
  return oldestQueuedAt < t && (lastSentAt ?? 0) < t;
}

export function describeNext(s: SendSettings, now: Date): string {
  if (s.send_mode === "immediate") return "נשלחות מיד";
  const n = nextScheduled(s, now)!;
  if (s.send_mode === "weekly") return `השליחה הבאה: יום ${HEB_D[n.getDay()]}`;
  return `השליחה הבאה: ${n.getDate()}/${n.getMonth() + 1}`;
}
