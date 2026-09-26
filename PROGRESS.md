# PROGRESS

Resume rule: read this file first, then `PLAN.md`, `DECISIONS.md`, `AGENTS.md`, then `git log`.
Commit messages are in Hebrew (מה שונה · למה · מה נבדק); hooks in `tools-git/` scan every commit.

## Status (2026-09-26, end of the autonomous run)
- **Phase 1 + Phase 2 + MFA + "reuse proven patterns": built and tested.** Everything that does not need the
  Supabase personal access token is live on the Supabase project: migrations 0001–0006, Realtime, Vault
  secrets, pg_cron jobs (`node scripts/setup-remote.mjs` ran the DB step).
- **Blocked on the user** (see SETUP.md steps 1–2, 5):
  1. `SUPABASE_ACCESS_TOKEN` → then `node scripts/setup-remote.mjs` deploys the 9 Edge Functions, sets their
     secrets and the auth settings (**sign-ups off**, Hebrew e-mail with the 6-digit code, TOTP on, SMS off, SMTP).
  2. SMTP (Brevo) + `SUPER_ADMIN_EMAIL` in `.env.local`.
  3. OK to push `main` → `node scripts/setup-remote.mjs --github --pages` then `git push origin main`
     (GitHub Actions builds, tests and deploys; prototype stays at `/legacy/`).
  4. After deploy: verify on the live URL (sign-in e-mail, invite, receipts batch, push on an iPhone).

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
- [ ] The 4 blocked steps above; then a live smoke test on an iPhone
- [ ] Lighthouse on the deployed URL (a local check was run — see the final report)

## Later (from the addendum — not now)
- Hebrew RTL-reversed text from PDFs (hub `fix_bidi`, docs/m245) if text-based PDF parsing is ever added
- Gmail attachment → Drive Apps Script (hub tools/06-gmail-scripts) for "import statements from e-mail"

## Known issues
- Commit 2285d16's message says "157 tests"; the correct count at that commit was 155.
