// Account-level functions:
//   delete-account  — full account deletion (households where you are alone go too)
//   mfa-recover     — a recovery code removes the lost authenticator; the user re-enrolls
//   mfa-reset       — an owner (aal2) resets MFA for a non-owner member of their household
import { RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { caller, isUuid, rateLimit } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";

export function createDeleteAccountHandler(deps: Deps) {
  return endpoint(deps, "delete-account", async (req, body) => {
    const claims = await caller(req, deps);
    await rateLimit(deps, `u:${claims.sub}`, "account", RATE.account);
    if (body.confirm !== "מחיקה") throw new HttpError(400, "confirm", "כדי למחוק צריך להקליד: מחיקה");
    // Deleting an account is sensitive: require the second factor if the user has one.
    const hasFactor = (await deps.admin.listFactorIds(claims.sub)).length > 0;
    if (hasFactor && claims.aal !== "aal2") throw new HttpError(403, "mfa_required", "צריך להזין קוד מאפליקציית האימות.");
    const prep = await deps.rpc<any>("svc_prepare_account_deletion", { p_user: claims.sub });
    if (!prep?.ok) {
      throw new HttpError(409, "last_owner",
        "אתם הבעלים היחידים של משק בית שיש בו עוד אנשים. צריך קודם להפוך מישהו אחר לבעלים, או למחוק את משק הבית.",
        { households: prep?.blocked ?? [] });
    }
    await deps.admin.deleteUser(claims.sub);
    deps.log("account_deleted", {});
    return { ok: true };
  }, { maxBytes: 1024 });
}

export function createMfaRecoverHandler(deps: Deps) {
  return endpoint(deps, "mfa-recover", async (req, body) => {
    const claims = await caller(req, deps);
    await rateLimit(deps, `u:${claims.sub}`, "recover", RATE.recover);
    const code = String(body.code ?? "").trim();
    if (code.length < 8 || code.length > 20) throw new HttpError(400, "bad_code", "קוד השחזור לא נכון.");
    const ok = await deps.rpc<boolean>("svc_use_recovery_code", { p_user: claims.sub, p_code: code });
    if (!ok) throw new HttpError(400, "bad_code", "קוד השחזור לא נכון או שכבר השתמשו בו.");
    for (const id of await deps.admin.listFactorIds(claims.sub)) await deps.admin.deleteFactor(claims.sub, id);
    await deps.rpc("svc_clear_recovery_codes", { p_user: claims.sub });
    deps.log("mfa_recovered", {});
    return { ok: true };
  }, { maxBytes: 1024 });
}

export function createMfaResetHandler(deps: Deps) {
  return endpoint(deps, "mfa-reset", async (req, body) => {
    const claims = await caller(req, deps);
    if (claims.aal !== "aal2") throw new HttpError(403, "mfa_required", "צריך להזין קוד מאפליקציית האימות.");
    await rateLimit(deps, `u:${claims.sub}`, "reset", RATE.reset);
    if (!isUuid(body.household_id) || !isUuid(body.user_id)) throw new HttpError(400, "bad_input", "חסרים פרטים.");
    const can = await deps.rpc<boolean>("svc_can_reset_mfa", {
      p_household: body.household_id, p_caller: claims.sub, p_target: body.user_id,
    });
    if (!can) throw new HttpError(403, "not_allowed", "אפשר לאפס אימות רק לבני בית שאינם בעלים.");
    for (const id of await deps.admin.listFactorIds(body.user_id)) await deps.admin.deleteFactor(body.user_id, id);
    await deps.rpc("svc_clear_recovery_codes", { p_user: body.user_id });
    deps.log("mfa_reset", {});
    return { ok: true };
  }, { maxBytes: 1024 });
}
