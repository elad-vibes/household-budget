# Project: "הכסף של הבית" – family household-budget PWA with a small backend

## Context
- A working single-file prototype is in this folder: `index.html` (live at https://elad-vibes.github.io/household-budget/). **Read it fully first.** Reuse its UX, Hebrew copy, categories (`CATS`/`EXCL`), Excel/CSV parser (`localParse`, `RULES`), rule-based tips (`localTips`), subscription detection (`SUBS`), whitelisted link catalog (`LINKS`), theme presets (`THEMES`) and backup format (`hb-data-v1`).
- Audience: a few Israeli families (≤10 households, ≤30 users), mostly iPhone, some Android. **Not** in the App Store: installed as a PWA from Safari/Chrome ("Add to Home Screen").
- Goal: solid, sensible security for a private family app. Do not over-engineer.

## Stack (use unless you have a strong reason, then explain in PLAN.md)
- Frontend: Vite + TypeScript, lightweight (vanilla or Preact). PWA: manifest, icons, service worker for the app shell. Hebrew RTL, mobile-first (390px), iOS safe areas. Deploy to GitHub Pages (repo `elad-vibes/household-budget`) with GitHub Actions.
- Backend: Supabase free tier – Postgres, Auth, Row Level Security, Edge Functions, pg_cron.
- AI: Anthropic Claude API, called **only** from Edge Functions. API key in Supabase secrets. Model IDs in config:
  - Receipts: `claude-haiku-4-5` via the **Message Batches API** (50% cheaper, async).
  - Card/bank statement photos or PDFs: `claude-sonnet-5`, synchronous (user reviews right away).
  - Monthly analysis: `claude-sonnet-5`, structured JSON output.

## Phase 1 (build now)
1. **Auth & access**
   - Email magic link (Google sign-in optional). No public sign-up: joining only through an invite link.
   - Household roles: `owner`, `member`, `viewer`. Owner creates invites (single-use token, 7-day expiry, role), removes members, renames the household. Each user has a display name.
   - Global `super_admin` (me) sees only usage, quotas and cost per household. Never transactions or amounts.
2. **Data model** (Postgres, RLS enabled on every table, default deny, policies by household membership)
   - `households`, `household_members`, `invites`, `transactions` (date, month, merchant, amount numeric(12,2), category, is_fixed, note, person_id, source, status `review|saved`, created_by, timestamps), `fixed_expenses`, `shopping_items`, `analyses`, `receipt_jobs`, `usage_ledger`, `household_settings` (theme, send mode, quotas).
   - People in a household can include members without a login (e.g. kids), for assigning expenses.
3. **Adding transactions**
   - Manual entry.
   - Excel/CSV import parsed **client-side** (port the prototype parser: Hebrew headers, windows-1255 CSV, installments "תשלום X מתוך Y", bank debit/credit, card lump-sum exclusion).
   - Statement photo/PDF → Edge Function `extract-statement` → review screen (edit category/fixed, uncheck rows) → save. Duplicate detection and a "sum of rows matches statement total" check, as in the prototype.
4. **Receipt queue (key feature)**
   - Capture with camera or pick a file. Client-side compression (≈1.2MP JPEG) and a blur check (e.g. Laplacian variance) that warns immediately so the user can retake.
   - Queued receipts are stored **on the device** (IndexedDB) with status.
   - Household setting "send mode": immediate / weekly (choose day) / monthly (choose date), default weekly. "Send now" button. Auto-send on the first app open after the scheduled time.
   - Edge Function `submit-receipts`: verify JWT + membership, enforce quota, create a Message Batch with the images inline. **No server-side image storage.** Record the job.
   - pg_cron every 30 min → Edge Function `poll-batches`: fetch results, insert transactions with status `review`, record actual token usage × price in `usage_ledger`.
   - App shows "X receipts waiting for approval". After a successful parse, delete the image from the device (optional per-receipt "keep for warranty", on-device only).
5. **Quotas & cost control**
   - Per-household monthly limits (images, statements, analyses, USD) set by super-admin, plus a global monthly USD cap.
   - Enforced server-side **before** every API call. Clear Hebrew message when exceeded. Queued receipts wait for the next period.
   - Super-admin screen: usage and cost per household this month.
6. **Overview & analysis** – port the prototype: totals, fixed vs variable, per person, categories, 6-month trend, fixed-expense status, subscriptions card. AI analysis via Edge Function (JSON; links **only** from the whitelisted catalog). Rule-based tips as a fallback.
7. Shared shopping list (Supabase realtime), themes, household members management.
8. **Backup:** export JSON and Excel. Import a prototype backup (`hb-data-v1`) so families can move their local data.
9. Onboarding screen with "Add to Home Screen" instructions for iPhone and Android.

## Phase 2 (build in the SAME run, after Phase 1 works end-to-end)
10. Category budgets with alerts at 80% and 100%.
11. Web Push notifications (iOS 16.4+ home-screen PWAs, VAPID keys in secrets): weekly summary, upcoming bills, "receipts ready for approval", budget alerts. Per-user opt-in and quiet hours.
12. Receipt line items → personal price history per product and store ("where was milk cheapest for us").
13. Annual/irregular expenses calendar (car insurance, arnona, annual subscriptions) with reminders.
14. Savings goals with progress.
15. Auto-suggest new fixed expenses from recurring transactions ("new 89 ₪ charge every month – add to fixed?").

## Security requirements
- RLS default deny on all tables. Automated tests proving user A cannot read or write household B, and viewers cannot write.
- Edge Functions: verify JWT and household membership, validate inputs (mime type, ≤5MB per image, max images per call), per-user rate limit.
- Anthropic key server-side only. Do not log request payloads or personal data.
- CORS restricted to the app origin. CSP on the frontend. HTTPS only.
- Account deletion and full household-data deletion.
- README must state honestly that the Supabase project owner has technical database access.

## UX
- Hebrew RTL, gender-neutral plural copy, large tap targets, light theme with the prototype's presets.
- Everything must work at 390px width on iPhone Safari as a home-screen app.

## How to run this (one autonomous run – do not stop for approvals)
- Build **everything** (Phase 1 then Phase 2) in this run. Do not pause to ask me to approve plans or steps. Make sensible decisions yourself and record them in `DECISIONS.md`.
- Stop and ask me **only** when you need something that requires my accounts or credentials (see prerequisites). Batch all such requests into one message, early.
- Work so it can be resumed if the session hits a usage limit: keep `PROGRESS.md` updated (done / in progress / next / known issues) and commit after every meaningful step with a clear message. If you are resumed, read `PROGRESS.md` first and continue.

## Prerequisites I will provide (ask for anything missing in ONE message at the start)
- Supabase project URL, anon key, service-role key and DB password (or I will run `supabase login` for you).
- Anthropic API key (for Edge Function secrets only – never commit it).
- GitHub repo `elad-vibes/household-budget` with push access (`gh auth login` done).
- Use `.env.local` (gitignored) for local secrets.

## Order of work
1. Read `index.html`. Write `PLAN.md` (architecture, full schema SQL, RLS policies, Edge Functions, receipt batch data flow, monthly cost estimate for 10 households) and continue immediately.
2. Phase 1: (a) schema + RLS + RLS tests, (b) auth + invites + roles, (c) core UI port, (d) Excel/CSV import, (e) statement extraction, (f) receipt queue + batch pipeline, (g) quotas + super-admin screen, (h) backup/import, (i) PWA + onboarding, (j) deploy and verify on the live URL.
3. Phase 2: items 10–15, each with tests, then redeploy.
4. Final pass: security review of every RLS policy and Edge Function (write findings to `SECURITY.md` and fix them), mobile check at 390px, Lighthouse PWA check.

## Deliverables
- Working app deployed to https://elad-vibes.github.io/household-budget/ (keep the current prototype reachable at `/legacy/` so existing users don't lose their local data, and add an "import from old version" flow).
- `SETUP.md`: click-by-click steps for a non-developer (Supabase settings, secrets, Anthropic Console monthly spend limit, creating the first household and invite links, how to redeploy).
- `ADMIN.md`: how I set quotas, see usage and cost, remove a household.
- Tests: RLS tests, parser unit tests with **synthetic** Max/Isracard/bank CSV samples, Edge Function tests with mocked Anthropic responses, a mobile-viewport E2E smoke test. Never use real personal data in fixtures.
- Final report: what was built, test results, anything not finished, and the exact steps I still need to do.

## Definition of done
- A new user can be invited, sign in with a magic link on iPhone Safari, add the app to the home screen, import an Excel statement, photograph receipts that get read in the weekly batch, see the overview and AI analysis, and cannot see any other household's data.
- All tests pass. No secrets in the repo.

## Addendum – two-factor authentication (added after the run started)
- Supabase Auth MFA with TOTP (authenticator apps: Google Authenticator, Microsoft Authenticator, or the iPhone Passwords app).
- **Required** for household owners and the super-admin; offered and encouraged for members and viewers (household owner can switch it to required for their household).
- Enforce in the database, not only in the UI: RLS policies on financial tables require `aal2` when the user has a verified factor or when the household requires MFA (`auth.jwt() ->> 'aal'`). Add RLS tests for aal1 vs aal2.
- Hebrew enrollment flow with QR code + manual code, verification step, and 10 one-time recovery codes (stored hashed). Owner can reset a member's MFA.
- Keep sessions long-lived on the device so family members are not asked for a code on every open; ask again on a new device or after sign-out.
- Do not use SMS (cost and SIM-swap risk). If Supabase supports passkeys/WebAuthn (Face ID) at build time, offer it as an additional option.

## Addendum – reuse proven patterns from Elad's `vibes-command` repo (C:\Users\elad_\Claude\brain\hub)
Read these files there (read-only – do not modify that repo) and port the patterns, not the business code:
1. **Pre-commit safety scan** – `engine/precommit_scan.py` + `tools-git/pre-commit`. Build the same for this repo: block commits containing secrets (`sb_secret_`, `sk-ant-`, JWTs, `.env*`), card/account numbers, Israeli ID numbers, and real names/amounts outside `tests/fixtures/` (which must be synthetic). Also scan the commit message.
2. **Allowlist `.gitignore`** (see hub `README.md`/`AGENTS.md`): block everything by default, allow only source paths with `!`. No user data, exports, screenshots or keys ever enter git.
3. **Loud column checks** – `engine/tabular.py`: when an Excel/CSV import is missing a required column (date / merchant / amount), fail loudly and show the user which columns were found, with header aliases per bank/card company. Never import 0 rows silently.
4. **Repo working rules** – mirror the relevant parts of hub `AGENTS.md`: Hebrew commit/PR descriptions (what changed, why, what was tested), code that produces communication creates drafts only, no business-rule numbers changed silently.
5. Not needed now, keep in mind for later: RTL-reversed text from Hebrew PDFs (the `fix_bidi` approach in `docs/m245-hebrew-search.md`) if text-based PDF parsing is ever added; Gmail attachment-to-Drive Apps Script (`tools/06-gmail-scripts/`) for a future "import statements from email" feature.
