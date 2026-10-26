// capture Edge Function (next-features.md §2): token header, amount parsing, category
// rules, foreign currency → review, no Origin needed (iPhone Shortcuts), rate limits.
import { describe, expect, it } from "vitest";
import { createCaptureHandler, parseAmount } from "../../supabase/functions/_shared/handlers/capture.ts";
import { makeDeps, req } from "./fakes.ts";

const TOKEN = "hbc_" + "ab".repeat(32);
const call = async (h: (r: Request) => Promise<Response>, r: Request) => { const res = await h(r); return { status: res.status, body: await res.json() }; };
function setup(svc: any = { ok: true, duplicate: false, status: "saved", method: "מקס" }, rateOk = true) {
  const { deps, s } = makeDeps({ rateOk });
  const base = deps.rpc;
  deps.rpc = (async (fn: string, args: any) => { if (fn === "svc_capture") { s.rpcCalls.push({ fn, args }); return svc; } return base(fn, args); }) as any;
  return { h: createCaptureHandler(deps), s };
}
const shortcut = (body: unknown, token: string | null = TOKEN) =>
  req(body, { origin: null, headers: token ? { "x-capture-token": token } : {} });

describe("parseAmount", () => {
  it("reads what Apple Pay / Shortcuts give", () => {
    expect(parseAmount("₪45.90")).toBe(45.9);
    expect(parseAmount("45,90 ₪")).toBe(45.9);
    expect(parseAmount("₪1,234.50")).toBe(1234.5);
    expect(parseAmount("1.234,50")).toBe(1234.5);
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount(12.345)).toBe(12.35);
    expect(parseAmount("-₪20")).toBe(-20);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("0")).toBeNull();
  });
});

describe("capture", () => {
  it("works without an Origin header (shortcuts), with the token header", async () => {
    const { h, s } = setup();
    const r = await call(h, shortcut({ amount: "₪312.40", merchant: "שופרסל דיל", card: "Max ••4321", kind: "wallet" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, text: "נקלט: ₪312.40 · שופרסל דיל" });
    const a = s.rpcCalls.find((c) => c.fn === "svc_capture")!.args;
    expect(a).toMatchObject({ p_token: TOKEN, p_amount: 312.4, p_kind: "wallet", p_card: "Max ••4321", p_category: "סופר ומכולת", p_category_known: true });
    expect(a.p_date).toBe("2026-09-26"); // Israel date of the fake clock
  });

  it("no / malformed token → 401 before any database work", async () => {
    for (const t of [null, "abc", "hbc_123"]) {
      const { h, s } = setup();
      expect((await call(h, shortcut({ amount: 5 }, t))).status).toBe(401);
      expect(s.rpcCalls).toHaveLength(0);
    }
  });

  it("revoked token / viewer → clear Hebrew errors", async () => {
    const { h } = setup({ ok: false, reason: "bad_token" });
    const r = await call(h, shortcut({ amount: 5 }));
    expect(r.status).toBe(401);
    expect(r.body.message).toContain("קוד חדש");
    const { h: v } = setup({ ok: false, reason: "not_allowed" });
    expect((await call(v, shortcut({ amount: 5 }))).status).toBe(403);
  });

  it("unknown merchant → no category (review); quick add keeps the chosen category", async () => {
    const { h, s } = setup({ ok: true, status: "review" });
    const r = await call(h, shortcut({ amount: "19.90", merchant: "חנות לא מוכרת" }));
    expect(r.body.text).toContain("מחכה לאישור");
    expect(s.rpcCalls.find((c) => c.fn === "svc_capture")!.args).toMatchObject({ p_category: null, p_category_known: false });
    const { h: q, s: s2 } = setup();
    await call(q, shortcut({ amount: 30, kind: "quick", category: "אוכל בחוץ ומשלוחים" }));
    expect(s2.rpcCalls.find((c) => c.fn === "svc_capture")!.args).toMatchObject({ p_kind: "quick", p_category: "אוכל בחוץ ומשלוחים", p_category_known: true });
  });

  it("a foreign-currency amount is noted and always reviewed", async () => {
    const { h, s } = setup({ ok: true, status: "review" });
    await call(h, shortcut({ amount: "฿350.00", merchant: "שופרסל דיל" }));
    expect(s.rpcCalls.find((c) => c.fn === "svc_capture")!.args).toMatchObject({ p_category_known: false, p_note: "סכום במטבע זר: ฿350.00" });
  });

  it("duplicate answer is reported; bad amount → 400; rate limited → 429", async () => {
    const { h } = setup({ ok: true, duplicate: true });
    expect((await call(h, shortcut({ amount: 5, merchant: "קפה" }))).body.text).toBe("כבר נקלט: ₪5.00 · קפה");
    const { h: b } = setup();
    expect((await call(b, shortcut({ amount: "שלום" }))).status).toBe(400);
    const { h: r } = setup(undefined, false);
    expect((await call(r, shortcut({ amount: 5 }))).status).toBe(429);
  });
});
