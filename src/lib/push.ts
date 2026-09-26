// Web Push on the device: permission, subscription, saving it (RLS: own rows only).
import { sb } from "./supa.ts";

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;

function b64uToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type PushResult = "ok" | "denied" | "unsupported" | "install-first" | "noconfig" | "error";

export async function enablePush(): Promise<PushResult> {
  if (!VAPID) return "noconfig";
  if (isIOS() && !standalone()) return "install-first"; // iOS: only home-screen apps get Web Push
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID) as BufferSource }));
    const j = sub.toJSON();
    await sb.from("push_subscriptions").delete().eq("endpoint", j.endpoint!);
    const { error } = await sb.from("push_subscriptions").insert({
      endpoint: j.endpoint, p256dh: j.keys!.p256dh, auth: j.keys!.auth, user_agent: navigator.userAgent.slice(0, 200),
    });
    return error ? "error" : "ok";
  } catch {
    return "error";
  }
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe().catch(() => undefined);
}
