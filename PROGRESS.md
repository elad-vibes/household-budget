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
- **Then:** live check on an iPhone — sign in with the e-mail code, 2FA enrollment, admin → new household → invite,
  Excel import, receipt photo → weekly batch, push notification test.

## Done
- [x] Prototype read; git on top of `origin/main`; prototype at `public/legacy/` (served at `/legacy/`)
- [x] PLAN.md (incl. full SQL), DECISIONS.md, AGENTS.md, README.md, SETUP.md, ADMIN.md, SECURITY.md
- [x] DB: 0001 core · 0002 RLS · 0003 RPCs · 0004 MFA (restrictive aal2) · 0005 app · 0006 Phase 2 — all applied live
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
