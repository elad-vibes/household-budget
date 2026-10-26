// price-compare: "איפה הכי זול?" for the shared shopping list (next-features.md §1).
// Source: SuperMCP's public REST API (Israeli price-transparency data, free, no key —
// terms + privacy reviewed, DECISIONS #34). Sends ONLY item names/quantities and the
// household's comparison city/street; never names, e-mails or ids. No Anthropic call.
// Results are trimmed, cached 6h per household + list, and rate limited per household.
import { RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { caller, rateLimit, requireAccess } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";

export const SUPERMCP = "https://supermcp.co.il";
export const CACHE_SECS = 6 * 3600;
const TIMEOUT_MS = 20_000;

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : null);
const httpsUrl = (v: unknown) => {
  try { const u = new URL(String(v)); return u.protocol === "https:" ? u.href : null; } catch { return null; }
};

export interface PriceStore {
  slug: string; brand: string; chain: string; total: number | null; comparable: number | null; items: number | null;
  fee: number | null; feeFloor: boolean; meetsMinimum: boolean; toMinimum: number | null; found: number; lines: number;
  url: string | null; asOf: string | null;
  rows: { i: number; name: string; qty: number; price: number | null; sub: boolean; promo: boolean; club: boolean }[];
  missing: { i: number; q: string }[];
}
export interface PriceResult {
  status: string; city: string | null; cheapest: string | null; fetchedAt: string; source: "SuperMCP";
  items: { i: number; q: string; name: string | null; resolved: boolean }[];
  stores: PriceStore[];
}

/** Trims SuperMCP's optimize answer to what the app shows (and nothing it doesn't). */
export function summarizeOptimize(raw: any, queries: string[], now: Date): PriceResult {
  const d = raw?.data ?? {};
  const plans: any[] = Array.isArray(d.plans) ? d.plans : [];
  const stores = plans
    .filter((p) => p && typeof p === "object")
    .sort((a, b) => (num(a.deliveredComparableTotal) ?? 1e9) - (num(b.deliveredComparableTotal) ?? 1e9))
    .slice(0, 8)
    .map((p): PriceStore => ({
      slug: str(p.serviceSlug, 60), brand: str(p.brand, 60) || str(p.chainName, 60), chain: str(p.chainName, 60),
      total: num(p.deliveredTotal), comparable: num(p.deliveredComparableTotal), items: num(p.itemsSubtotal),
      fee: num(p.deliveryFee), feeFloor: !!p.deliveryFeeIsFloor, meetsMinimum: p.meetsMinimum !== false,
      toMinimum: num(p.amountToMinimum), found: Number(p.pricedLines) || 0, lines: Number(p.requestedLines) || queries.length,
      url: httpsUrl(p.storefrontUrl), asOf: str(p.priceFeedAsOf, 30) || null,
      rows: (Array.isArray(p.lines) ? p.lines : []).slice(0, 50).map((l: any) => ({
        i: Number(l.itemIndex) || 0, name: str(l.name, 80), qty: Number(l.qty) || 1, price: num(l.lineTotal),
        sub: !!l.substituted, promo: !!l.promoApplied, club: !!l.clubOnly,
      })),
      missing: (Array.isArray(p.missingItems) ? p.missingItems : []).slice(0, 50).map((m: any) => {
        const i = Number(m?.itemIndex ?? m?.index) || 0;
        return { i, q: str(m?.query ?? m?.name, 80) || queries[i] || "" };
      }),
    }));
  return {
    status: str(d.status, 30) || "complete",
    city: str(d.address?.city, 60) || null,
    cheapest: str(d.cheapestDelivered?.serviceSlug, 60) || null,
    fetchedAt: now.toISOString(),
    source: "SuperMCP",
    items: queries.map((q, i) => {
      const it = (Array.isArray(d.items) ? d.items : []).find((x: any) => Number(x?.index) === i);
      return { i, q, name: str(it?.name, 80) || null, resolved: it?.resolutionStatus === "resolved" };
    }),
    stores,
  };
}

async function listHash(items: { name: string; qty: number }[], city: string, street: string) {
  const data = new TextEncoder().encode(JSON.stringify([items, city, street]));
  const h = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getJson(deps: Deps, url: string, init?: RequestInit) {
  const f = deps.fetch ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, { ...init, signal: ctl.signal, headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const DOWN = () => new HttpError(502, "service_down", "השוואת המחירים לא זמינה כרגע. אפשר לנסות שוב מאוחר יותר, או להשתמש בקישורי ההשוואה.");

export function createPriceCompareHandler(deps: Deps) {
  return endpoint(deps, "price-compare", async (req, body) => {
    const claims = await caller(req, deps);
    const hh = body.household_id;
    await requireAccess(deps, hh, claims, "read");

    // "פריט דומה" for an item a chain doesn't have
    if (body.similar !== undefined) {
      const q = str(body.similar, 60);
      if (q.length < 2) throw new HttpError(400, "bad_query", "צריך שם מוצר.");
      await rateLimit(deps, `h:${hh}`, "price_similar", RATE.priceSimilar);
      let raw: any;
      try { raw = await getJson(deps, `${SUPERMCP}/v1/products/similar?q=${encodeURIComponent(q)}&limit=4`); }
      catch { deps.log("supermcp_down", { fn: "similar" }); throw DOWN(); }
      const products = (Array.isArray(raw?.data?.products) ? raw.data.products : []).slice(0, 4)
        .map((p: any) => ({ name: str(p.name, 80), brand: str(p.brand, 40) })).filter((p: any) => p.name);
      return { ok: true, similar: products };
    }

    const input = await deps.rpc<{ items: { name: string; qty: number }[]; city: string | null; street: string | null }>(
      "svc_price_compare_input", { p_household: hh });
    const items = (input?.items ?? []).map((i) => ({ name: str(i.name, 60), qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) }))
      .filter((i) => i.name.length >= 2);
    if (!items.length) throw new HttpError(400, "empty", "רשימת הקניות ריקה — אין מה להשוות.");
    const city = str(input?.city, 60);
    if (!city) throw new HttpError(400, "need_city", "צריך לבחור עיר להשוואה (פעם אחת).");
    const street = str(input?.street, 80);

    const hash = await listHash(items, city, street);
    const cached = await deps.rpc<PriceResult | null>("svc_price_cache_get", { p_household: hh, p_hash: hash, p_max_age_secs: CACHE_SECS });
    if (cached) return { ok: true, cached: true, result: cached };

    await rateLimit(deps, `h:${hh}`, "price", RATE.price);
    const queries = items.map((i) => i.name);
    const reqBody = {
      items: items.map((i) => (i.qty > 1 ? { query: i.name, amount: i.qty, unit: "יח" } : { query: i.name })),
      city, ...(street ? { address: `${street}, ${city}` } : {}),
    };
    let raw: any;
    try {
      raw = await getJson(deps, `${SUPERMCP}/v1/delivery/optimize`, { method: "POST", body: JSON.stringify(reqBody) });
    } catch (e) {
      deps.log("supermcp_down", { fn: "optimize", reason: String((e as Error)?.message ?? "").slice(0, 40) });
      throw DOWN();
    }
    const result = summarizeOptimize(raw, queries, deps.now());
    await deps.rpc("svc_price_cache_put", { p_household: hh, p_hash: hash, p_result: result });
    deps.log("price_compare", { items: items.length, stores: result.stores.length });
    return { ok: true, cached: false, result };
  }, { maxBytes: 4 * 1024 });
}
