# PROGRESS

Resume rule: read this file first, then `PLAN.md`, `DECISIONS.md`, `AGENTS.md`, then `git log`.
Commit messages are in Hebrew (מה שונה · למה · מה נבדק); hooks in `tools-git/` scan every commit.

## Status (2026-09-26)
- **Now:** Phase 2 (items 10–15) — next step: migration `0006_phase2.sql`
- **Live Supabase:** reachable via session pooler `aws-0-eu-central-1` (cached in `supabase/.temp/pooler-host`,
  gitignored). Migrations 0001–0005 and `remote/realtime.sql` applied. (Re-apply with `node scripts/db.mjs migrate` and
  
  `node scripts/db.mjs sql supabase/remote/realtime.sql`.)
- **Still needed from the user** (asked in chat 2026-09-26):
  1. Supabase personal access token (`SUPABASE_ACCESS_TOKEN`) — required for: deploying Edge Functions,
     setting function secrets, auth config (disable sign-ups, OTP e-mail template with the 6-digit code,
     redirect URLs, SMTP). The Management API accepts nothing else.
  2. SMTP credentials (Brevo/Resend) — Supabase's built-in mailer only reaches the project team.
  3. Super-admin e-mail confirmation. 4. OK to push to `main` + switch Pages to GitHub Actions.
- **Security note until (1) arrives:** Supabase Auth still has default settings (public sign-up enabled).
  RLS keeps data safe (a stranger has no household), but sign-ups must be disabled at setup.

## Done
- [x] Prototype read; git on top of `origin/main`; prototype at `public/legacy/` (served at `/legacy/`)
- [x] PLAN.md, DECISIONS.md, AGENTS.md
- [x] (a) Schema + RLS + RPCs (0001–0003) · (a2) MFA in the DB (0004: restrictive aal2 policies, recovery codes)
- [x] RLS tests: 84 — pass on PGlite AND on the live DB (`RLS_TARGET=remote npx vitest run tests/rls`)
- [x] Edge Functions (logic in `supabase/functions/_shared/handlers`): invite-signin, extract-statement,
      submit-receipts, poll-batches, analyze-month, delete-account, mfa-recover, mfa-reset.
      34 handler tests (mocked Anthropic); `npm run check:functions` green. **Not deployed (needs PAT).**
- [x] Frontend: all Phase 1 screens (overview, add + receipt queue + statement review, tx + receipt approval,
      fixed, shopping w/ Realtime, home/settings, auth + invite join, 2FA enroll/challenge/recovery, admin,
      install/onboarding), PWA (manifest, icons, SW, CSP), backup export JSON/Excel + import v1/v2 +
      "import from old version" (same-origin localStorage `hb-data-v1`)
- [x] Addendum "reuse proven patterns": pre-commit + commit-msg scan, allowlist .gitignore, loud column
      checks with per-issuer aliases, AGENTS.md rules; synthetic data in `tests/fixtures/`
- [x] Tests: `npm test` 155 (RLS 84 + functions 34 + unit 37) · `npx playwright test` 5 (390px, live, synthetic)

## Next
- [ ] Phase 2: 0006 migration (budgets, budget_alerts, push_subscriptions, notification_prefs,
      notification_queue, receipt_items, annual_expenses, savings_goals, goal_deposits,
      suggestion_dismissals — all with mfa_gate) + RLS tests
- [ ] Phase 2: Web Push (`_shared/webpush.ts`, VAPID + RFC 8291 aes128gcm, test vector) + `notify` function
- [ ] Phase 2 UI: plan tab (budgets 80/100%, annual calendar, goals), overview cards, price history in shop,
      fixed-expense suggestions, notification settings (opt-in, quiet hours)
- [ ] Deploy (after PAT + push OK): migrations 0005/0006, realtime.sql, cron (vault secrets), functions + secrets,
      auth config, GitHub Actions Pages workflow, repo variables; verify live URL
- [ ] Final: SECURITY.md review + fixes · Lighthouse · SETUP.md · ADMIN.md · README · final report

## Later (from the addendum — not now)
- Hebrew RTL-reversed text from PDFs (hub `fix_bidi`, docs/m245) if text-based PDF parsing is ever added
- Gmail attachment → Drive Apps Script (hub tools/06-gmail-scripts) for "import statements from e-mail"

## Known issues
- Commit 2285d16's message says "157 tests"; the correct count at that commit was 155.
