// capture: expenses from iPhone Shortcuts (next-features.md §2) — the Apple Pay "Wallet"
// automation (kind "wallet") and a Back Tap quick-add shortcut (kind "quick").
// Auth = a per-user capture token (header X-Capture-Token), not a session: a shortcut
// can't sign in. The token is stored hashed and only ever adds expenses for its own
// user in its own household (svc_capture, 0011). Shortcuts send no Origin header.
import { RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { clientIp, rateLimit } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";
import { catsFor } from "../catalog.ts";
import { regionOf } from "../region.ts";
import { catOf } from "../rules.ts";
import { CURRENCY, parseForeign, refreshRates } from "../fx.ts";

const TOKEN = /^hbc_[0-9a-f]{64}$/;

/** "₪1,234.50", "45,90 ש״ח", 12.3 → number; null if unreadable. */
export function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) && v !== 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^-|\(.*\)|−/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? Math.round((neg ? -n : n) * 100) / 100 : null;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v).slice(0, n) : "");
/** YYYY-MM-DD in the household's time zone (Israel unless its region says otherwise, 0016) */
const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

const REASON: Record<string, [number, string]> = {
  bad_token: [401, "הקוד של קיצור הדרך לא תקין או בוטל. צריך ליצור קוד חדש באפליקציה (הבית → קליטה אוטומטית)."],
  not_allowed: [403, "למשתמש הזה אין הרשאה להוסיף הוצאות במשק הבית."],
  invalid: [400, "הסכום או הסוג לא תקינים."],
};

export function createCaptureHandler(deps: Deps) {
  return endpoint(deps, "capture", async (req, body) => {
    const auth = req.headers.get("x-capture-token") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const token = auth.trim();
    if (!TOKEN.test(token)) throw new HttpError(401, "bad_token", REASON.bad_token[1]);
    await rateLimit(deps, `ip:${clientIp(req)}`, "capture_ip", RATE.captureIp);
    await rateLimit(deps, `t:${token.slice(4, 20)}`, "capture", RATE.capture);

    const kind = body.kind === "quick" ? "quick" : body.kind === "wallet" || body.kind === undefined ? "wallet" : "";
    const rawAmount = body.amount;
    const amount = parseAmount(rawAmount);
    if (!kind || amount === null) throw new HttpError(400, "invalid", "לא הצלחתי לקרוא את הסכום.");
    const merchant = str(body.merchant, 80);
    // the household's region (0016): base currency, time zone and which category rules apply. A token that
    // doesn't resolve is answered by svc_capture itself (bad_token); an unknown region is Israel.
    const reg = regionOf(await deps.rpc<string | null>("svc_capture_region", { p_token: token }).catch(() => null));
    // currency: sent explicitly, else from the amount text ("฿350.00" from Apple Pay abroad),
    // else "" = the household's trip currency while trip mode is on, its base currency otherwise (svc_capture)
    const explicit = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
    const currency = CURRENCY.test(explicit) ? explicit : typeof rawAmount === "string" ? parseForeign(rawAmount)?.currency ?? "" : "";
    if (currency !== reg.currency) await refreshRates(deps);   // never throws; the conversion uses whatever is cached
    let category: string | null = null;
    let known = false;
    if (typeof body.category === "string" && (catsFor(reg.code) as readonly string[]).includes(body.category)) { category = body.category; known = true; }
    else if (merchant) { const c = catOf(merchant, reg.code).category; if (c !== "שונות") { category = c; known = true; } }
    const note = str(body.note, 120);

    const r = await deps.rpc<{ ok: boolean; reason?: string; duplicate?: boolean; status?: string; method?: string | null;
      amount?: number; original_amount?: number | null; currency?: string }>("svc_capture", {
      p_token: token, p_amount: amount, p_merchant: merchant, p_card: str(body.card, 40), p_kind: kind,
      p_category: category, p_category_known: known, p_note: note, p_date: localDate(deps.now(), reg.tz), p_currency: currency,
    });
    if (!r?.ok) {
      const [status, msg] = REASON[r?.reason ?? "invalid"] ?? REASON.invalid;
      throw new HttpError(status, r?.reason ?? "invalid", msg);
    }
    const ils = typeof r.amount === "number" ? r.amount : amount;
    const orig = r.original_amount ? ` (${Math.abs(r.original_amount).toFixed(2)} ${r.currency})` : "";
    const what = `${reg.symbol}${Math.abs(ils).toFixed(2)}${orig}${merchant ? " · " + merchant : ""}`;
    return {
      ok: true, duplicate: !!r.duplicate, status: r.status ?? null,
      text: r.duplicate ? `כבר נקלט: ${what}` : r.status === "review" ? `נקלט ומחכה לאישור: ${what}` : `נקלט: ${what}`,
    };
  }, { allowNoOrigin: true, maxBytes: 2048 });
}
