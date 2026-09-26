# PROGRESS

Resume rule: read this file first, then `PLAN.md` and `DECISIONS.md`, then `git log`.

## Status
- **Now:** Phase 1 — (b) auth + invites, then (c) core UI port
- **Blocked on user (credentials):** Supabase URL/keys/DB password + personal access token,
  Anthropic key, SMTP (Brevo/Resend), super-admin e-mail, push permission. Asked in chat on 2026-09-26.
  Everything is built and tested locally until they arrive.

## Done
- [x] Read prototype (`legacy/index.html`) and the prompt
- [x] Git on top of the existing repo history (`origin/main`), prototype moved to `legacy/`
- [x] PLAN.md, DECISIONS.md
- [x] (a) Schema + RLS + RPCs (`supabase/migrations/0001–0003`), RLS tests on PGlite — 74 passing

## Next (Phase 1)
- [ ] (b) auth + invites (Edge Function `invite-signin`, join screen, code sign-in)
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

## Final
- [ ] SECURITY.md review + fixes · 390px check · Lighthouse · SETUP.md · ADMIN.md · README · final report

## Known issues
- (none yet)
