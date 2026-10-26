# PROGRESS

Resume rule: read this file first, then `PLAN.md`, `DECISIONS.md`, `AGENTS.md`, then `git log`.
Commit messages are in Hebrew (מה שונה · למה · מה נבדק); hooks in `tools-git/` scan every commit.

## Status (2026-09-27)
- **Backend is LIVE:** 9 Edge Functions deployed with their secrets; auth configured (sign-ups off, Hebrew e-mail
  with the 6-digit code via Brevo SMTP, TOTP on, SMS off; WebAuthn MFA not available on this project → hidden);
  super-admin account created; pg_cron jobs calling poll-batches / notify verified (200 with the cron secret, 401 without).
- GitHub: repo variables set, Pages source = GitHub Actions.
- **DEPLOYED 2026-09-27:** pushed; GitHub Actions run "deploy #1" green; live URL serves the new app (CSP, manifest,
  service worker active, `/legacy/` = 200, no sideways scroll at 375px). Elad to revoke the Supabase access tokens.
- **2026-09-27 (session 2):** 0007 + 0008 applied live; frontend for roles / payment methods / design committed, waiting for push.
- **Then:** live check on an iPhone — sign in with the e-mail code, 2FA enrollment, admin → new household → invite,
  Excel import, receipt photo → weekly batch, push notification test.

## ▶ HANDOFF (2026-10-26, session 3 — next-features.md) — next session starts here
Order: next-features.md §1 → 2 → 3 → 4 → 5 → (6 only if room). One feature = one commit, migrations from 0010,
tests green, before/after at 390px in `docs/features/<n>-<name>/` (`SHOTS=before|after SHOTS_DIR=… npx playwright test screens -g …`).

| # | Feature | Status |
|---|---|---|
| 1 | "איפה הכי זול?" (SuperMCP) | ✅ committed — migration 0010 **applied live**; Edge Function `price-compare` **NOT deployed** (token in .env.local is revoked → needs a new one) |
| 2 | Apple Pay / Back Tap capture | next |
| 3 | Budget month start + "כמה נשאר להיום" | — (regression-sensitive: month-boundary tests before AND after) |
| 4 | Vouchers wallet | — |
| 5 | Trip mode / foreign currency | — |
| 6 | "השכונה שלנו" | optional |

**Feature 1 notes:** REST API (`/openapi.json`), terms + privacy reviewed → DECISIONS #34 (credit shown, 10/day/household,
6h cache, only item names + chosen city/street leave the server). UI `src/ui/price.ts` replaces the static links card
(links stay as fallback). Tests: functions/price (8, mocked ok/partial/down/cache/rate/need-city/similar), rls/price (2),
e2e/price (2, function intercepted). Live check after deploy: `node scratch/smcp.mjs` style call through the function.
Also from an earlier side session: 0009 date_sanity (live) + month-selection guard on statement upload (b78ec0d, 764a686).

**Waiting on Elad:** push `main`; a NEW Supabase access token (Full access) to deploy `price-compare` (and later `capture`), revoke after.
**email-import.md** still waits for the domain. `backup.md` not requested.

**What was built**
- Roles: one owner per household (partial unique index), owner invites only by super-admin for empty households,
  `transfer_ownership()` (aal2, demote then promote), owner can't leave/delete account without a transfer; UI "העברת ניהול".
- Payment methods: `payment_methods` (last4 only), default methods per household, "איך שילמת?" chips (remembered per
  person), statement import asks the method once (auto-detect by last4/issuer, remembered per file source), pure matcher
  `src/domain/match.ts` (±1₪ or 1st installment, date −2…+5, fuzzy merchant, bit rows), merge = logged row survives with
  statement amount/date (`apply_statement` / `merge_statement_row`, security invoker, one transaction), "ממתין לפירוט"
  badge, "לבדוק" / "מזומן" / "לפי אמצעי תשלום" cards, fixed ↔ method, new excluded category "משיכת מזומן".
- Design: see design-brief.md; decisions 30–33; ASSETS.md; before/after at 390px in `docs/design-pass/` (after incl. dark).

**Checks (design pass 87d99da; after bug fixes: Playwright 9/9, unit 208):** `npm test` 208 (RLS 108 · functions 40 · unit 60) · typecheck · check:functions 9 · Playwright 7/7
(smoke 5, payments, design) + 12 screenshot tests · Lighthouse (build, mobile) a11y 100 / BP 100 / SEO 100 / perf 97 ·
axe-core wcag2aa clean on 7 signed-in screens, light + dark.

**Next (after the push):** iPhone live check — sign in with the e-mail code, owner 2FA, "העברת ניהול" with a test member,
add a card + card expense + cash expense, import a card Excel → "הותאם", splash screen / icon after re-adding to home screen, dark mode.

## Done
- [x] Prototype read; git on top of `origin/main`; prototype at `public/legacy/` (served at `/legacy/`)
- [x] PLAN.md (incl. full SQL), DECISIONS.md, AGENTS.md, README.md, SETUP.md, ADMIN.md, SECURITY.md
- [x] DB: 0001 core · 0002 RLS · 0003 RPCs · 0004 MFA (restrictive aal2) · 0005 app · 0006 Phase 2 · 0007 single owner · 0008 payment methods — all applied live
- [x] household-roles.md · payment-methods.md · design-brief.md (session 2, see HANDOFF)
- [x] Edge Functions (9): invite-signin, extract-statement, submit-receipts, poll-batches, analyze-month,
      delete-account, mfa-recover, mfa-reset, notify — `npm run check:functions` green (**not deployed: needs PAT**)
- [x] Frontend: all Phase 1 screens + Phase 2 (plan tab: budgets 80/100%, annual calendar, goals; overview cards;
      price history; fixed suggestions; notification settings) + 2FA + admin + PWA
- [x] Security review (SECURITY.md): 5 findings fixed, 1 open (auth defaults until setup-remote runs with PAT)
- [x] Tests: `npm test` 178 (RLS 92 · functions 40 · unit 46) · RLS 92 also on the live DB ·
      `npx playwright test` 5 (390px, live Supabase, synthetic data, incl. 2FA gate and plan tab)

## Next
- [x] Token, SMTP, super-admin, setup-remote (all steps green)
- [ ] Push (Elad) + live smoke test on an iPhone
- [ ] Lighthouse on the deployed URL (a local check was run — see the final report)

## Later (from the addendum — not now)
- Hebrew RTL-reversed text from PDFs (hub `fix_bidi`, docs/m245) if text-based PDF parsing is ever added
- Gmail attachment → Drive Apps Script (hub tools/06-gmail-scripts) for "import statements from e-mail"

## Known issues
- Commit 2285d16's message says "157 tests"; the correct count at that commit was 155.
- email-import.md (email forwarding + share-to-app) — next in line, waiting for Elad's domain (see HANDOFF)
