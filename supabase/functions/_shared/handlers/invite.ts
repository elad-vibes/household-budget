// invite-signin (public): shows who invited you, and prepares the invited
// account. Sign-ups are disabled in Supabase Auth, so the invited user is
// created here with the admin API — only after the invite token was verified
// and bound to this e-mail. The app then sends the sign-in e-mail itself.
import { RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { clientIp, rateLimit } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";

const TOKEN = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const REASONS: Record<string, string> = {
  invalid: "הקישור לא תקין או שבוטל. אפשר לבקש קישור חדש ממי שהזמין אתכם.",
  used: "הקישור כבר שימש להצטרפות. אם זה היה אצלכם, פשוט מתחברים עם המייל.",
  expired: "תוקף הקישור (7 ימים) עבר. אפשר לבקש קישור חדש.",
  claimed: "הקישור כבר נקשר לכתובת מייל אחרת.",
};

export function createInviteHandler(deps: Deps) {
  return endpoint(deps, "invite-signin", async (req, body) => {
    const token = String(body.token ?? "");
    if (!TOKEN.test(token)) throw new HttpError(400, "invalid", REASONS.invalid);
    await rateLimit(deps, `ip:${clientIp(req)}`, "invite", RATE.inviteIp);
    await rateLimit(deps, `tok:${token.slice(0, 16)}`, "invite", RATE.inviteToken);

    if (body.action === "info") {
      const info = await deps.rpc<any>("svc_invite_info", { p_token: token });
      if (!info?.ok) throw new HttpError(410, info?.reason ?? "invalid", REASONS[info?.reason] ?? REASONS.invalid);
      return { ok: true, household_name: info.household_name, role: info.role, person_name: info.person_name };
    }

    if (body.action === "claim") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, "bad_email", "כתובת המייל לא נראית תקינה.");
      const claim = await deps.rpc<any>("svc_claim_invite", { p_token: token, p_email: email });
      if (!claim?.ok) throw new HttpError(410, claim?.reason ?? "invalid", REASONS[claim?.reason] ?? REASONS.invalid);
      const created = await deps.admin.createUser(email);
      deps.log("invite_claimed", { created: created === "created" });
      return { ok: true };
    }

    throw new HttpError(400, "bad_action", "פעולה לא מוכרת.");
  }, { allowNoOrigin: false, maxBytes: 4096 });
}
