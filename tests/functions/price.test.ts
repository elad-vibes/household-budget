// price-compare Edge Function with a mocked SuperMCP (next-features.md §1):
// ok / partial / down, cache, rate limit, need-city, and exactly what leaves the server.
import { describe, expect, it } from "vitest";
import { createPriceCompareHandler, summarizeOptimize } from "../../supabase/functions/_shared/handlers/price.ts";
import { HH, makeDeps, req } from "./fakes.ts";

const call = async (h: (r: Request) => Promise<Response>, r: Request) => {
  const res = await h(r);
  return { status: res.status, body: await res.json() };
};

const plan = (slug: string, total: number, over: Record<string, unknown> = {}) => ({
  serviceSlug: slug, brand: slug.toUpperCase(), chainName: slug, deliveredTotal: total, deliveredComparableTotal: total,
  itemsSubtotal: total - 30, deliveryFee: 30, deliveryFeeIsFloor: false, meetsMinimum: true, amountToMinimum: null,
  pricedLines: 2, requestedLines: 2, storefrontUrl: `https://${slug}.example.test/`, priceFeedAsOf: "2026-10-25T05:00:00.000Z",
  lines: [{ itemIndex: 0, name: "חלב 3% 1 ליטר", qty: 1, lineTotal: 6.41, substituted: false, promoApplied: false, clubOnly: false }],
  missingItems: [], ...over,
});
const OK = { data: { status: "complete", address: { city: "עיר לדוגמה" }, cheapestDelivered: { serviceSlug: "a" },
  items: [{ index: 0, name: "חלב 3% 1 ליטר", resolutionStatus: "resolved" }, { index: 1, name: null, resolutionStatus: "unresolved" }],
  plans: [plan("b", 90), plan("a", 71.03, { missingItems: [{ itemIndex: 1, query: "שמרים טריים" }], pricedLines: 1 })] } };

function setup(opts: { input?: any; cached?: any; fetchImpl?: (url: string, init: any) => Promise<Response>; rateOk?: boolean } = {}) {
  const { deps, s } = makeDeps({ rateOk: opts.rateOk ?? true });
  const sent: { url: string; body: any }[] = [];
  const base = deps.rpc;
  deps.rpc = (async (fn: string, args: any) => {
    if (fn === "svc_price_compare_input") { s.rpcCalls.push({ fn, args }); return opts.input ?? { items: [{ name: "חלב 3%", qty: 1 }, { name: "שמרים טריים", qty: 2 }], city: "עיר לדוגמה", street: "רחוב הדוגמה 1" }; }
    if (fn === "svc_price_cache_get") { s.rpcCalls.push({ fn, args }); return opts.cached ?? null; }
    return base(fn, args);
  }) as any;
  deps.fetch = (async (url: string, init: any) => {
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return opts.fetchImpl ? opts.fetchImpl(url, init) : new Response(JSON.stringify(OK), { status: 200 });
  }) as any;
  return { h: createPriceCompareHandler(deps), s, sent };
}
const body = { household_id: HH };

describe("price-compare", () => {
  it("needs a session and membership", async () => {
    const { h } = setup();
    expect((await call(h, req(body))).status).toBe(401);
    const { h: h2, s } = setup();
    s.access = { role: null, mfa_required: false, mfa_ok: true };
    expect((await call(h2, req(body, { token: "tok-aal1" }))).status).toBe(403);
  });

  it("ranks stores by delivered total; sends only item names, quantities and the location", async () => {
    const { h, s, sent } = setup();
    const r = await call(h, req(body, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body.result.stores.map((x: any) => x.slug)).toEqual(["a", "b"]);
    expect(r.body.result.stores[0]).toMatchObject({ total: 71.03, fee: 30, found: 1, missing: [{ i: 1, q: "שמרים טריים" }] });
    expect(r.body.result.items[1]).toEqual({ i: 1, q: "שמרים טריים", name: null, resolved: false });
    expect(r.body.result.source).toBe("SuperMCP");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://supermcp.co.il/v1/delivery/optimize");
    expect(sent[0].body).toEqual({
      items: [{ query: "חלב 3%" }, { query: "שמרים טריים", amount: 2, unit: "יח" }],
      city: "עיר לדוגמה", address: "רחוב הדוגמה 1, עיר לדוגמה",
    });
    expect(JSON.stringify(sent[0].body)).not.toMatch(/household|@|user/i);
    expect(s.rpcCalls.some((c) => c.fn === "svc_price_cache_put")).toBe(true);
  });

  it("a cached answer (6h) costs no external call and no rate-limit slot", async () => {
    const cached = summarizeOptimize(OK, ["חלב 3%", "שמרים טריים"], new Date("2026-10-26T08:00:00Z"));
    const { h, s, sent } = setup({ cached });
    const r = await call(h, req(body, { token: "tok-aal1" }));
    expect(r.body).toMatchObject({ ok: true, cached: true });
    expect(sent).toHaveLength(0);
    expect(s.rpcCalls.some((c) => c.fn === "svc_rate_limit")).toBe(false);
    expect(s.rpcCalls.find((c) => c.fn === "svc_price_cache_get")!.args.p_max_age_secs).toBe(6 * 3600);
  });

  it("partial answer: unknown fee and below-minimum stores are reported, not hidden", async () => {
    const partial = { data: { status: "complete", plans: [plan("c", 50, { deliveryFee: null, deliveredTotal: null, meetsMinimum: false, amountToMinimum: 22.5 })] } };
    const { h } = setup({ fetchImpl: async () => new Response(JSON.stringify(partial), { status: 200 }) });
    const r = await call(h, req(body, { token: "tok-aal1" }));
    expect(r.body.result.stores[0]).toMatchObject({ fee: null, total: null, meetsMinimum: false, toMinimum: 22.5 });
  });

  it("service down / error status → 502 with a Hebrew message (the app shows the fallback links)", async () => {
    for (const impl of [async () => { throw new Error("network"); }, async () => new Response("{}", { status: 503 })]) {
      const { h } = setup({ fetchImpl: impl as any });
      const r = await call(h, req(body, { token: "tok-aal1" }));
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("service_down");
    }
  });

  it("rate limited per household; empty list and missing city are clear errors", async () => {
    const { h, s } = setup({ rateOk: false });
    expect((await call(h, req(body, { token: "tok-aal1" }))).status).toBe(429);
    expect(s.rpcCalls.find((c) => c.fn === "svc_rate_limit")!.args).toMatchObject({ p_key: `h:${HH}`, p_bucket: "price" });
    const { h: e } = setup({ input: { items: [], city: "עיר", street: null } });
    expect((await call(e, req(body, { token: "tok-aal1" }))).body.error).toBe("empty");
    const { h: c } = setup({ input: { items: [{ name: "חלב", qty: 1 }], city: null, street: null } });
    expect((await call(c, req(body, { token: "tok-aal1" }))).body.error).toBe("need_city");
  });

  it("similar products for a missing item", async () => {
    const sim = { data: { products: [{ name: "שמרים יבשים 100 גרם", brand: "דוגמה" }] } };
    const { h, sent } = setup({ fetchImpl: async () => new Response(JSON.stringify(sim), { status: 200 }) });
    const r = await call(h, req({ ...body, similar: "שמרים טריים" }, { token: "tok-aal1" }));
    expect(r.body.similar).toEqual([{ name: "שמרים יבשים 100 גרם", brand: "דוגמה" }]);
    expect(sent[0].url).toContain("/v1/products/similar?q=");
  });

  it("storefront links must be https; anything else is dropped", () => {
    const res = summarizeOptimize({ data: { plans: [plan("x", 10, { storefrontUrl: "javascript:alert(1)" })] } }, ["a"], new Date());
    expect(res.stores[0].url).toBeNull();
  });
});
