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

## ▶ HANDOFF (2026-09-27) — next session starts here
Elad's request (verbatim): "Read PROGRESS.md, then payment-methods.md and design-brief.md in this folder. Do payment-methods.md
first (migration + RLS tests + matcher unit tests + UI + E2E), then the design pass from design-brief.md. Commit after each step,
keep all tests green, add before/after screenshots at 390px, deploy when done, and update PROGRESS.md. Also read
household-roles.md and apply it first (before payment-methods.md)."  → ORDER: household-roles → payment-methods → design-brief.
`backup.md` also exists but was NOT requested yet — don't build it unless asked.

**Open issue first:** login e-mail failed because the Supabase SMTP username was wrong. `.env.local` SMTP_USER is fixed and a
Brevo SMTP login test passes (`node scratch/smtp-test.mjs`). Elad was asked to fix Username in Supabase → Authentication →
Emails → SMTP Settings. Confirm the code e-mail now arrives (diagnostic: `node scratch/diag-mail.mjs`).
Supabase access tokens were revoked → any Edge Function / auth-config change needs a NEW token (Preset = Full access, revoke after).

### Step 0 — "before" screenshots
New `tests/e2e/screens.spec.ts` (runs only when `SHOTS=before|after`), live synthetic fixture (`tests/e2e/live.ts`),
390px PNGs of signin, overview, tx, add, fixed, plan, shop, home → `docs/design-pass/<before|after>/`.
Add `!/docs/design-pass/**` to the allow-list `.gitignore` (requested by design-brief; synthetic data only; note in DECISIONS).

### Step 1 — household-roles.md (migration 0007_single_owner.sql)
- Check live data first: no household may already have 2 owners.
- `create unique index household_one_owner on household_members(household_id) where role = 'owner'`.
- `create_invite`: reject `p_role = 'owner'`; `accept_invite`: reject an owner invite if the household already has an owner
  (admin owner-invites exist only for member-less households).
- `set_member_role`: refuse promoting to owner ('use_transfer').
- New `transfer_ownership(p_household, p_new_owner)`: `is_owner()` (implies aal2) + target member/viewer → demote caller
  FIRST, then promote target (one transaction; order avoids the unique index).
- Leave / delete-account with other members → "צריך קודם להעביר את הניהול" (dbMessage last_owner; delete-account handler
  text needs a function redeploy = new token).
- UI (home.ts): remove owner from invite + role selects; card "העברת ניהול": pick member → confirm → rpc → reload.
- Tests (tests/rls/roles.test.ts): 2nd owner rejected, owner invite rejected, promote-to-owner rejected, member can't
  transfer/promote self, owner at aal1 can't transfer, transfer swaps roles, owner can't leave without transfer.
- MFA: keep the current DB rule. Update ADMIN.md + DECISIONS.md.

### Step 2 — payment-methods.md (migration 0008_payment_methods.sql)
- `payment_methods` (type check cash|credit_card|debit_card|bank_transfer|standing_order|bit_paybox|other, label ≤40,
  issuer ≤30, last4 `^\d{4}$` nullable, person_id composite FK, active, sort, unique(household_id,id)); RLS + mfa_gate + tests.
- transactions: `payment_method_id` (composite FK, set null), `match_status` none|awaiting_statement|matched|
  unmatched_after_statement, `matched_transaction_id` (audit), `payment_hint`; add to update grants. fixed_expenses: `payment_method_id`.
- Merge model: the receipt/manual row SURVIVES (keeps category/note/person/receipt_items), takes statement amount/date/month;
  the statement row is not inserted (import) or deleted (statement first). Awaiting rows count once; leftovers →
  unmatched_after_statement in "לבדוק".
- Pure matcher `src/domain/match.ts` + unit tests (exact, ±1₪, date −2…+5, installments, fuzzy merchant, two candidates,
  none, refunds). New EXCL category "משיכת מזומן" (ATM rule). Receipt schema/prompt `payment` hint + SQL prefill (redeploy).
- UI: methods manager, "איך שילמת?" chips (remember per person), import asks the method once (auto-detect last4/issuer,
  remember per file), match summary + ambiguous review, "ממתין לפירוט" badge, cards "מזומן" + split by method; fixed ↔ method.
- E2E: cash + card receipt → import synthetic statement → card merged, cash stays, totals not doubled.

### Step 3 — design-brief.md (no business logic/RLS/function changes)
Icon + iOS splash, time-of-day greeting, own inline-SVG illustrations (theme tokens) + ASSETS.md, Lucide (MIT) category icons +
merchant avatars, hero gradient + count-up + sparkline, SVG donut (tap → filtered tx), budget rings, goal jar + confetti
(reduced-motion aware), tip icons, skeletons, transitions, pressed states, swipe-delete + undo, pull-to-refresh, floating
camera + capture sheet + sharpness badge, dark mode. Then "after" screenshots, Playwright green, Lighthouse a11y 100,
deploy (push authorized in this request), update PROGRESS.md.

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
