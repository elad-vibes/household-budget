// fx-rates Edge Function + the shared fx module (next-features.md §5): Bank of Israel / ECB
// parsing, cross rates, conversion rounding, amount-with-currency parsing, daily cache,
// fallback when a source (or both) is down, manual rates, statement rows from abroad.
import { describe, expect, it } from "vitest";
import { BOI_URL, ECB_URL, parseBoi, parseEcb, parseForeign, refreshRates, toIls } from "../../supabase/functions/_shared/fx.ts";
import { createFxRatesHandler } from "../../supabase/functions/_shared/handlers/fx.ts";
import { sanitizeStatement } from "../../supabase/functions/_shared/ai.ts";
import { HH, makeDeps, req } from "./fakes.ts";

const BOI = { exchangeRates: [
  { key: "USD", currentExchangeRate: 3.078, currentChange: -1.09, unit: 1, lastUpdate: "2026-10-26T13:22:03.8272789Z" },
  { key: "JPY", currentExchangeRate: 1.9557, currentChange: -1.3, unit: 100, lastUpdate: "2026-10-26T13:22:03.8272789Z" },
  { key: "EUR", currentExchangeRate: 3.4462, currentChange: -1.1, unit: 1, lastUpdate: "2026-10-26T13:22:03.8272789Z" },
  { key: "BAD", currentExchangeRate: -1, unit: 1, lastUpdate: "2026-10-26T13:22:03Z" },
] };
const ECB = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-10-26'>
  <Cube currency='USD' rate='1.1188'/><Cube currency='THB' rate='37.821'/><Cube currency='ILS' rate='3.4458'/>
  <Cube currency='TRY' rate='55.6746'/></Cube></Cube></gesmes:Envelope>`;

const call = async (h: (r: Request) => Promise<Response>, r: Request) => { const res = await h(r); return { status: res.status, body: await res.json() }; };

function setup(opts: { claim?: boolean; boi?: "ok" | "down"; ecb?: "ok" | "down"; rates?: any; rateOk?: boolean } = {}) {
  const { deps, s } = makeDeps({ rateOk: opts.rateOk ?? true });
  const fetched: string[] = [];
  let put: any[] | null = null;
  const base = deps.rpc;
  deps.rpc = (async (fn: string, args: any) => {
    if (fn === "svc_fx_claim") { s.rpcCalls.push({ fn, args }); return opts.claim ?? true; }
    if (fn === "svc_fx_put") { s.rpcCalls.push({ fn, args }); put = args.p_rows; return args.p_rows.length; }
    if (fn === "svc_fx_rates") {
      s.rpcCalls.push({ fn, args });
      return opts.rates ?? { official: { THB: { rate: 0.091107, date: "2026-10-26", source: "ecb" } }, manual: {}, last_success: "2026-09-26T09:00:00Z" };
    }
    return base(fn, args);
  }) as any;
  deps.fetch = (async (url: string) => {
    fetched.push(url);
    if (url === BOI_URL) return opts.boi === "down" ? new Response("err", { status: 503 }) : new Response(JSON.stringify(BOI), { status: 200 });
    if (url === ECB_URL) { if (opts.ecb === "down") throw new Error("network"); return new Response(ECB, { status: 200 }); }
    throw new Error("unexpected url " + url);
  }) as any;
  return { h: createFxRatesHandler(deps), deps, s, fetched, put: () => put };
}

describe("fx: parsing and conversion", () => {
  it("Bank of Israel: ₪ per 1 unit (JPY is per 100), Israel date, junk dropped", () => {
    expect(parseBoi(BOI)).toEqual([
      { currency: "USD", date: "2026-10-26", rate: 3.078, source: "boi" },
      { currency: "JPY", date: "2026-10-26", rate: 0.019557, source: "boi" },
      { currency: "EUR", date: "2026-10-26", rate: 3.4462, source: "boi" },
    ]);
    expect(parseBoi(null)).toEqual([]);
  });

  it("ECB: cross rates through the euro (₪/€ ÷ X/€)", () => {
    const rows = parseEcb(ECB);
    expect(rows.find((r) => r.currency === "THB")).toEqual({ currency: "THB", date: "2026-10-26", rate: 0.091108, source: "ecb" });
    expect(rows.find((r) => r.currency === "EUR")!.rate).toBe(3.4458);
    expect(rows.find((r) => r.currency === "ILS")).toBeUndefined();
    expect(parseEcb("<xml/>")).toEqual([]);
  });

  it("toIls rounds to agorot half away from zero, like Postgres", () => {
    expect(toIls(350, 0.0905)).toBe(31.68);     // 31.675 — float says 31.674999…
    expect(toIls(200, 0.0911)).toBe(18.22);
    expect(toIls(-350, 0.0905)).toBe(-31.68);   // a refund
    expect(toIls(1, 3.078)).toBe(3.08);
  });

  it("parseForeign reads Apple Pay / receipt amounts with their currency", () => {
    expect(parseForeign("฿350.00")).toEqual({ amount: 350, currency: "THB" });
    expect(parseForeign("THB 1,250.00")).toEqual({ amount: 1250, currency: "THB" });
    expect(parseForeign("€12,50")).toEqual({ amount: 12.5, currency: "EUR" });
    expect(parseForeign("$7")).toEqual({ amount: 7, currency: "USD" });
    expect(parseForeign("A$7")).toEqual({ amount: 7, currency: "AUD" });   // the longer symbol wins
    expect(parseForeign("₪45.90")).toEqual({ amount: 45.9, currency: "ILS" });
    expect(parseForeign("45,90 ש״ח")).toEqual({ amount: 45.9, currency: "ILS" });
    expect(parseForeign("350")).toEqual({ amount: 350, currency: "" });
    expect(parseForeign("abc")).toBeNull();
  });
});

describe("fx: daily cache and fallback", () => {
  it("fetches both sources when due; ECB only adds what the Bank of Israel doesn't publish", async () => {
    const { deps, fetched, put } = setup();
    expect(await refreshRates(deps)).toBe("fetched");
    expect(fetched.sort()).toEqual([BOI_URL, ECB_URL].sort());
    const codes = put()!.map((r: any) => `${r.currency}:${r.source}`).sort();
    expect(codes).toEqual(["EUR:boi", "JPY:boi", "THB:ecb", "TRY:ecb", "USD:boi"]);
  });

  it("not due → no external call at all", async () => {
    const { deps, fetched, s } = setup({ claim: false });
    expect(await refreshRates(deps)).toBe("cached");
    expect(fetched).toEqual([]);
    expect(s.rpcCalls.some((c) => c.fn === "svc_fx_put")).toBe(false);
  });

  it("Bank of Israel down → the ECB covers every currency (partial); both down → nothing written", async () => {
    const a = setup({ boi: "down" });
    expect(await refreshRates(a.deps)).toBe("partial");
    expect(a.put()!.map((r: any) => r.currency).sort()).toEqual(["EUR", "THB", "TRY", "USD"]);
    const b = setup({ boi: "down", ecb: "down" });
    expect(await refreshRates(b.deps)).toBe("down");
    expect(b.put()).toBeNull();
  });
});

describe("fx-rates endpoint", () => {
  it("needs a session and membership", async () => {
    const { h } = setup();
    expect((await call(h, req({ household_id: HH }))).status).toBe(401);
    const { h: h2, s } = setup();
    s.access = { role: null, mfa_required: false, mfa_ok: true };
    expect((await call(h2, req({ household_id: HH }, { token: "tok-aal1" }))).status).toBe(403);
  });

  it("returns official + manual rates; a fresh fetch is not stale", async () => {
    const rates = { official: { THB: { rate: 0.091108, date: "2026-10-26", source: "ecb" } }, manual: { THB: { rate: 0.095, date: "2026-10-26" } },
      last_success: "2026-09-26T09:30:00Z" };
    const { h } = setup({ rates });
    const r = await call(h, req({ household_id: HH }, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, fetched: "fetched", stale: false, official: rates.official, manual: rates.manual });
  });

  it("both sources down but rates cached → still 200, with the age (stale after 4 days)", async () => {
    const rates = { official: { THB: { rate: 0.0905, date: "2026-09-18", source: "ecb" } }, manual: {}, last_success: "2026-09-18T12:00:00Z" };
    const { h } = setup({ boi: "down", ecb: "down", rates });
    const r = await call(h, req({ household_id: HH }, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fetched: "down", stale: true, lastSuccess: "2026-09-18T12:00:00Z" });
  });

  it("nothing cached and the sources down → 502 telling to enter a rate by hand", async () => {
    const { h } = setup({ boi: "down", ecb: "down", rates: { official: {}, manual: {}, last_success: null } });
    const r = await call(h, req({ household_id: HH }, { token: "tok-aal1" }));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toMatch(/שער ידני/);
  });

  it("rate limited per household → 429", async () => {
    const { h } = setup({ rateOk: false });
    expect((await call(h, req({ household_id: HH }, { token: "tok-aal1" }))).status).toBe(429);
  });
});

describe("statement rows from abroad (sanitizeStatement)", () => {
  it("keeps the original amount + currency and derives the card's rate; ₪ rows and junk get nothing", () => {
    const doc = sanitizeStatement({ docType: "credit_card", title: "פירוט", statementTotal: null, rows: [
      { date: "2026-10-22", month: "2026-10", merchant: "AIRASIA", amount: 412.5, category: "חופשות", fixed: false, note: "", original_amount: 110, original_currency: "usd" },
      { date: "2026-10-23", month: "2026-10", merchant: "רמי לוי", amount: 99.9, category: "סופר ומכולת", fixed: false, note: "", original_amount: null, original_currency: null },
      { date: "2026-10-24", month: "2026-10", merchant: "X", amount: 10, category: "שונות", fixed: false, note: "", original_amount: 5, original_currency: "ILS" },
      { date: "2026-10-25", month: "2026-10", merchant: "החזר", amount: -31.7, category: "חופשות", fixed: false, note: "", original_amount: 350, original_currency: "THB" },
    ] });
    expect(doc.rows[0]).toMatchObject({ original_amount: 110, original_currency: "USD", fx_rate: 3.75 });
    expect(doc.rows[1].original_currency).toBeUndefined();
    expect(doc.rows[2].original_currency).toBeUndefined();
    expect(doc.rows[3]).toMatchObject({ original_amount: -350, original_currency: "THB", fx_rate: 0.090571 });  // sign follows the ₪ amount
  });
});
