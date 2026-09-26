// Authentication, household membership + MFA, rate limits and quotas.
import type { Claims, Deps } from "./deps.ts";
import { HttpError } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export async function caller(req: Request, deps: Deps): Promise<Claims> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) throw new HttpError(401, "no_session", "צריך להתחבר מחדש.");
  const claims = await deps.verifyJwt(m[1].trim());
  if (!claims || !isUuid(claims.sub) || (claims.role && claims.role !== "authenticated")) {
    throw new HttpError(401, "bad_session", "צריך להתחבר מחדש.");
  }
  return claims;
}

type Access = { role: string | null; mfa_required: boolean; mfa_ok: boolean };

/** Membership + role + the same MFA rule the RLS policies use. */
export async function requireAccess(
  deps: Deps, household: unknown, claims: Claims, need: "read" | "write",
): Promise<{ role: string }> {
  if (!isUuid(household)) throw new HttpError(400, "bad_household", "חסר מזהה משק בית.");
  const a = await deps.rpc<Access>("svc_access", { p_household: household, p_user: claims.sub, p_aal: claims.aal ?? "aal1" });
  if (!a || !a.role) throw new HttpError(403, "not_member", "אין לך גישה למשק הבית הזה.");
  if (!a.mfa_ok) throw new HttpError(403, "mfa_required", "צריך להזין קוד מאפליקציית האימות.");
  if (need === "write" && a.role === "viewer") {
    throw new HttpError(403, "viewer", "יש לך הרשאת צפייה בלבד.");
  }
  return { role: a.role };
}

export async function rateLimit(deps: Deps, key: string, bucket: string, [max, windowSecs]: [number, number]) {
  const ok = await deps.rpc<boolean>("svc_rate_limit", { p_key: key, p_bucket: bucket, p_max: max, p_window_secs: windowSecs });
  if (!ok) throw new HttpError(429, "rate_limited", "יותר מדי בקשות בזמן קצר. אפשר לנסות שוב בעוד כמה דקות.");
}

const QUOTA_TEXT: Record<string, string> = {
  quota_receipt: "הגעתם למכסת הקבלות של החודש. הקבלות יחכו במכשיר ויישלחו בחודש הבא.",
  quota_statement: "הגעתם למכסת קריאת הפירוטים של החודש. אפשר להעלות קובץ Excel או CSV, שנקרא בלי הגבלה.",
  quota_analysis: "הגעתם למכסת הניתוחים של החודש. ההמלצות האוטומטיות עדיין זמינות.",
  quota_usd: "הגעתם לתקרת העלות החודשית של משק הבית. אפשר לבקש ממנהל המערכת להגדיל אותה.",
  global_cap: "הגענו לתקרת העלות החודשית של כל המערכת. הקריאה האוטומטית תחזור בתחילת החודש הבא.",
  no_household: "משק הבית לא נמצא.",
};

export function quotaMessage(reason: string): string {
  return QUOTA_TEXT[reason] ?? "המכסה החודשית נוצלה.";
}

/** Reserves estimated cost against the quotas BEFORE the API call. */
export async function reserve(
  deps: Deps, household: string, user: string, kind: "receipt" | "statement" | "analysis",
  units: number, estUsd: number, model: string,
): Promise<string> {
  const r = await deps.rpc<{ ok: boolean; reservation_id?: string; reason?: string; used?: number; quota?: number }>(
    "svc_reserve_usage",
    { p_household: household, p_user: user, p_kind: kind, p_units: units, p_est_usd: estUsd, p_model: model, p_ref: null },
  );
  if (!r?.ok || !r.reservation_id) {
    const reason = r?.reason ?? "quota";
    throw new HttpError(402, "quota_exceeded", quotaMessage(reason), { reason, used: r?.used ?? null, quota: r?.quota ?? null });
  }
  return r.reservation_id;
}

export async function finalize(deps: Deps, id: string, units: number, input: number, output: number, usd: number) {
  await deps.rpc("svc_finalize_usage", { p_id: id, p_units: units, p_input: input, p_output: output, p_usd: usd });
}

export async function release(deps: Deps, id: string) {
  try {
    await deps.rpc("svc_release_usage", { p_id: id });
  } catch {
    deps.log("release_failed", { id });
  }
}

/**
 * The caller's IP for rate limiting. cf-connecting-ip is set by the edge proxy;
 * otherwise the LAST x-forwarded-for hop (the one added by our proxy) — the
 * first entries can be supplied by the client and must not be trusted.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}
