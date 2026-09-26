// Service worker: precaches the app shell (offline start) and shows Web Push
// notifications. Supabase API calls always go to the network.
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

// ------------------------------------------------------------ Web Push
interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

self.addEventListener("push", (e) => {
  let d: PushPayload = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  const title = d.title || "הכסף של הבית";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    tag: d.tag,
    lang: "he",
    dir: "rtl",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./#/overview" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data?.url as string) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await (w as WindowClient).focus();
        (w as WindowClient).navigate(target).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
