// Web Push: RFC 8291 Appendix A test vector, VAPID signature, push-service
// allowlist, and the notify handler (cron + test action).
import { describe, expect, it } from "vitest";
import { b64u, encryptPayload, importP256, isPushEndpoint, vapidAuthorization, generateVapidKeys } from "../../supabase/functions/_shared/webpush.ts";
import { createNotifyHandler } from "../../supabase/functions/_shared/handlers/notify.ts";
import { makeDeps, req } from "./fakes.ts";

// RFC 8291 Appendix A — published test values (synthetic by definition).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("Web Push crypto", () => {
  it("matches the RFC 8291 test vector byte for byte", async () => {
    const asPublic = b64u.dec(RFC.asPublic);
    const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { asPrivate: await importP256(RFC.asPrivate, asPublic, "ECDH"), asPublic, salt: b64u.dec(RFC.salt) });
    expect(b64u.enc(body)).toBe(RFC.body);
  });

  it("VAPID JWT is signed with the VAPID key and scoped to the push service", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", "mailto:admin@example.test", keys.publicKey, keys.privateKey, 1_750_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(b64u.dec(m[2])));
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:admin@example.test" });
    const pub = await crypto.subtle.importKey("raw", b64u.dec(keys.publicKey) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64u.dec(m[3]) as BufferSource, new TextEncoder().encode(`${m[1]}.${m[2]}`) as BufferSource);
    expect(ok).toBe(true);
  });

  it("only real push services are contacted", () => {
    expect(isPushEndpoint("https://web.push.apple.com/QGuQyavXutnMH")).toBe(true);
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false);
  });
});

describe("notify handler", () => {
  const vapid = async () => {
    const k = await generateVapidKeys();
    return { vapidPublicKey: k.publicKey, vapidPrivateKey: k.privateKey, vapidSubject: "mailto:admin@example.test" };
  };
  const sub = (id: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`) =>
    ({ subscription_id: id, endpoint, p256dh: RFC.uaPublic, auth: RFC.authSecret });

  it("cron: requires the secret, sends due items, drops dead subscriptions", async () => {
    const { deps, s } = makeDeps();
    Object.assign(deps.env, await vapid());
    const calls: string[] = [];
    deps.fetch = (async (url: string) => { calls.push(url); return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 }); }) as any;
    const due = [
      { queue_id: "q1", ...sub("s1"), title: "סיכום שבועי", body: "x", url: "./#/overview", tag: "weekly:1" },
      { queue_id: "q2", ...sub("s2", "https://fcm.googleapis.com/fcm/send/gone"), title: "חיוב קרוב", body: "y", url: "./#/fixed", tag: "bill:1" },
    ];
    deps.rpc = (async (fn: string, args: any) => { s.rpcCalls.push({ fn, args }); return fn === "svc_due_notifications" ? due : null; }) as any;
    const h = createNotifyHandler(deps);
    expect((await h(req({}, { origin: null, headers: { "x-cron-secret": "wrong" } }))).status).toBe(401);
    const r = await h(req({}, { origin: null, headers: { "x-cron-secret": "cron-secret-for-tests-0123456789" } }));
    expect(await r.json()).toEqual({ ok: true, due: 2, sent: 2 });
    expect(calls).toHaveLength(2);
    const mark = s.rpcCalls.find((c) => c.fn === "svc_mark_sent")!.args;
    expect(mark).toEqual({ p_queue: ["q1", "q2"], p_ok_subs: ["s1"], p_dead_subs: ["s2"] });
  });

  it("test action: signed-in users only, to their own devices", async () => {
    const { deps, s } = makeDeps();
    Object.assign(deps.env, await vapid());
    deps.fetch = (async () => new Response(null, { status: 201 })) as any;
    deps.rpc = (async (fn: string, args: any) => { s.rpcCalls.push({ fn, args }); return fn === "svc_user_subscriptions" ? [sub("mine")] : fn === "svc_rate_limit" ? true : null; }) as any;
    const h = createNotifyHandler(deps);
    expect((await h(req({ action: "test" }))).status).toBe(401);
    const r = await h(req({ action: "test" }, { token: "tok-aal1" }));
    expect(await r.json()).toEqual({ ok: true, sent: 1 });
    expect(s.rpcCalls.find((c) => c.fn === "svc_user_subscriptions")!.args.p_user).toBe("22222222-2222-4222-8222-222222222222");
  });
});
