// fx-rates: "מצב טיול" (next-features.md §5) — the rates the app converts with.
// Official daily rates (Bank of Israel, ECB cross rates for the rest — see ../fx.ts), cached
// for everyone in fx_rates and fetched at most once a day; the household's manual rates win.
// Fallback: a source being down never fails the call while any cached rate exists — the answer
// says how old it is. Nothing at all → 502 with "enter a rate by hand". No Anthropic call.
import { RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { refreshRates } from "../fx.ts";
import { caller, rateLimit, requireAccess } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";

/** Older than this (days) → the app says the official rate may be out of date. */
export const STALE_DAYS = 4;

interface Rates {
  official: Record<string, { rate: number; date: string; source: "boi" | "ecb" }>;
  manual: Record<string, { rate: number; date: string }>;
  last_success: string | null;
}

export function createFxRatesHandler(deps: Deps) {
  return endpoint(deps, "fx-rates", async (req, body) => {
    const claims = await caller(req, deps);
    const hh = body.household_id;
    await requireAccess(deps, hh, claims, "read");
    await rateLimit(deps, `h:${hh}`, "fx", RATE.fx);

    const fetched = await refreshRates(deps);
    const r = await deps.rpc<Rates>("svc_fx_rates", { p_household: hh });
    const official = r?.official ?? {}, manual = r?.manual ?? {};
    if (!Object.keys(official).length && !Object.keys(manual).length) {
      throw new HttpError(502, "fx_down", "שערי המטבע לא זמינים כרגע. אפשר להזין שער ידני בהגדרות מצב טיול.");
    }
    const last = r?.last_success ? new Date(r.last_success) : null;
    const stale = !last || deps.now().getTime() - last.getTime() > STALE_DAYS * 86_400_000;
    return { ok: true, fetched, stale, lastSuccess: r?.last_success ?? null, official, manual };
  }, { maxBytes: 1024 });
}
