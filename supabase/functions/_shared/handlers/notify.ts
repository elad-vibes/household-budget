// notify:
//   * pg_cron (every 30 min, cron secret): due notifications → Web Push
//     (weekly summary, upcoming bills/annual, receipts ready, budget alerts),
//     quiet hours and dedupe are handled in svc_due_notifications().
//   * {action: "test"} from the app (signed-in user): one test push to the
//     caller's own devices.
import type { Deps } from "../deps.ts";
import { caller, rateLimit } from "../guard.ts";
import { endpoint, HttpError, safeEqual } from "../http.ts";
import { sendPush, type PushMessage, type PushSubscriptionKeys } from "../webpush.ts";

interface DueRow { queue_id: string; subscription_id: string; endpoint: string; p256dh: string; auth: string; title: string; body: string; url: string; tag: string }

export function createNotifyHandler(deps: Deps) {
  const vapid = () => {
    const { vapidPublicKey, vapidPrivateKey, vapidSubject } = deps.env;
    if (!vapidPublicKey || !vapidPrivateKey) throw new HttpError(503, "push_not_configured", "ההתראות עוד לא הוגדרו בשרת.");
    return { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject || "mailto:admin@example.invalid" };
  };
  const fetchFn = deps.fetch ?? fetch;

  async function deliver(sub: PushSubscriptionKeys, msg: PushMessage): Promise<"ok" | "dead" | "retry"> {
    try {
      const status = await sendPush(fetchFn, sub, msg, vapid());
      if (status >= 200 && status < 300) return "ok";
      if (status === 404 || status === 410) return "dead";
      return "retry";
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return "retry";
    }
  }

  return endpoint(deps, "notify", async (req, body) => {
    if (body.action === "test") {
      const claims = await caller(req, deps);
      await rateLimit(deps, `u:${claims.sub}`, "pushtest", [5, 3600]);
      const subs = await deps.rpc<{ subscription_id: string; endpoint: string; p256dh: string; auth: string }[]>(
        "svc_user_subscriptions", { p_user: claims.sub });
      const ok: string[] = [], dead: string[] = [];
      for (const s of subs ?? []) {
        const r = await deliver(s, { title: "התראת בדיקה", body: "ההתראות מ״הכסף של הבית״ עובדות במכשיר הזה.", url: "./#/home", tag: "test" });
        if (r === "ok") ok.push(s.subscription_id);
        if (r === "dead") dead.push(s.subscription_id);
      }
      await deps.rpc("svc_mark_sent", { p_queue: [], p_ok_subs: ok, p_dead_subs: dead });
      return { ok: true, sent: ok.length };
    }

    if (!safeEqual(req.headers.get("x-cron-secret") ?? "", deps.env.cronSecret)) {
      throw new HttpError(401, "unauthorized", "unauthorized");
    }
    const rows = await deps.rpc<DueRow[]>("svc_due_notifications", { p_now: deps.now().toISOString() });
    const sentQueue = new Set<string>(), ok = new Set<string>(), dead = new Set<string>();
    for (const r of rows ?? []) {
      const res = await deliver(r, { title: r.title, body: r.body, url: r.url, tag: r.tag });
      if (res === "ok") { ok.add(r.subscription_id); sentQueue.add(r.queue_id); }
      if (res === "dead") { dead.add(r.subscription_id); sentQueue.add(r.queue_id); }
    }
    await deps.rpc("svc_mark_sent", { p_queue: [...sentQueue], p_ok_subs: [...ok], p_dead_subs: [...dead] });
    deps.log("notify_run", { due: rows?.length ?? 0, sent: ok.size, dead: dead.size });
    return { ok: true, due: rows?.length ?? 0, sent: sentQueue.size };
  }, { allowNoOrigin: true, maxBytes: 1024 });
}
