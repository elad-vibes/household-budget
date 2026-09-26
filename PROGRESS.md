# PROGRESS

Resume rule: read this file first, then `PLAN.md` and `DECISIONS.md`, then `git log`.

## Status
- **Now:** Phase 1 — frontend: app shell + auth/MFA screens + UI port (src/ui/*)
- **Live Supabase:** project reachable (session pooler `aws-0-eu-central-1`, cached in
  `supabase/.temp/pooler-host`, gitignored). Migrations 0001–0004 applied with
  `node scripts/db.mjs migrate`. RLS suite passes against the live DB
  (`RLS_TARGET=remote npm run test:rls`, runs in one rolled-back transaction).
- **Still needed from the user:** Supabase personal access token (for Edge Function
  deploy + secrets + auth config — the Management API accepts nothing else), SMTP
  credentials, super-admin e-mail confirmation, push-to-main confirmation.

## Done
- [x] Read prototype (`legacy/index.html`) and the prompt (+ MFA addendum)
- [x] Git on top of the existing repo history (`origin/main`), prototype moved to `legacy/`
- [x] PLAN.md, DECISIONS.md
- [x] (a) Schema + RLS + RPCs (`supabase/migrations/0001–0003`), RLS tests — local PGlite + live DB
- [x] (a2) **MFA in the database** (`0004_mfa.sql`): restrictive `mfa_gate` policies on all
      household data, `is_owner()`/`is_super_admin()` require aal2, `require_mfa` per household
      (owner RPC), hashed recovery codes, `svc_access` for Edge Functions,
      `svc_can_reset_mfa`. RLS tests for aal1 vs aal2 — 84 passing

- [x] Edge Functions (logic in `supabase/functions/_shared/handlers`, thin Deno wrappers): invite-signin,
      extract-statement, submit-receipts, poll-batches, analyze-month, delete-account, mfa-recover, mfa-reset.
      34 handler tests (mocked Anthropic); `npm run check:functions` (deno check) green. NOT deployed yet (needs PAT).
- [x] Frontend domain layer: parser (port of localParse), calc (sums/tips/summary), schedule, image
      (compress + Laplacian blur), IndexedDB queue, backup v1/v2 — unit tests with synthetic Max/Isracard/bank files
- Total tests: 147 passing (`npm test`)

## Next (Phase 1)
- [ ] (b) auth + invites UI: join screen, e-mail code sign-in
- [ ] (b2) MFA UI (Hebrew): enroll (QR + manual code) → verify → 10 recovery codes;
      code prompt on new device; recovery-code flow (Edge Function `mfa-recover`);
      owner "reset member MFA" (Edge Function `mfa-reset`); household "require MFA" switch;
      passkey/WebAuthn as an extra option if the project supports it
- [ ] (c) core UI port (overview, tx, fixed, shopping, home, themes)
- [ ] (d) Excel/CSV import (port `localParse`) + parser unit tests with synthetic Max/Isracard/bank CSVs
- [ ] (e) statement extraction (`extract-statement`) + review screen
- [ ] (f) receipt queue (IndexedDB, compression, blur) + `submit-receipts` + `poll-batches`
- [ ] (g) quotas + super-admin screen
- [ ] (h) backup export (JSON/Excel) + import `hb-data-v1`
- [ ] (i) PWA (manifest, icons, SW) + onboarding
- [ ] (j) deploy + verify live

## Phase 2
- [ ] 10 budgets · 11 Web Push · 12 price history · 13 annual calendar · 14 savings goals · 15 fixed suggestions
      (Phase 2 tables get the same restrictive `mfa_gate` policy)

## Final
- [ ] SECURITY.md review + fixes · 390px check · Lighthouse · SETUP.md · ADMIN.md · README · final report

## Known issues
- (none yet)
