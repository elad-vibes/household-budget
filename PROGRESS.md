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

## ▶ Admin dashboard (2026-10-26, session 4) — branch `claude/admin-dashboard`
Stacked on `claude/receipt-date-bug` (that branch is still unpushed) → push this branch; it contains both.
Commits: f224a9f (0012 + RLS tests) · aaac85e (collector + page) · 91962f9 (server installer + docs). DECISIONS #36, SETUP "לוח ניהול".
- Built: `stats_snapshot()` (aggregates only, role `hb_stats` only), `scripts/stats/*` (collect / render / role / bundle /
  install-server.sh). Page: `https://95-217-135-115.sslip.io/bayit-admin/`, Caddy basicauth user `elad`, rebuilt every 5 min.
- Checks: `npm test` 263 (new: rls/stats 7, unit/stats 11) · typecheck · scan · page checked in the browser with synthetic
  data at desktop + 375px (light only — the pane renders local files light; dark tokens are in the CSS but unseen).
- **DONE 2026-10-26/27:** pushed + merged to main; 0012 live; hb_stats login; installed on the server by M2 (crontab every 5 min,
  Caddy basicauth); page live and green (screenshot from Elad 27.10). Nothing left here.
- Elad first asked for a Claude Artifact dashboard, then chose his server instead → no Artifact was published.

## ▶ HANDOFF (2026-10-28, session 9 — אזור תאילנד) — next session starts here
Branch `claude/thailand-region` (from origin/main bc173b4). One commit; Elad sends it to GitHub. DECISIONS #42.
- Built: `household_settings.region` IL|TH (0016) → base currency ILS/THB, time zone, default payment methods (+ new type `e_wallet`), Thai banks as issuer
  suggestions, 2 extra categories + Thai classification rules, AI prompts per region, price comparison hidden for TH, rule-based tips without Israeli links,
  cross rates through the shekel for a THB base, notification text with the household's sign. Region card in הבית (owner only, only while the household is empty).
- Checks: `npm test` (RLS region 11 · unit region 23 · capture TH 2, all old tests unchanged) · typecheck · build · scan · `npx playwright test` 19 passed
  (the Israeli household, unchanged) + `thailand.spec` 8 passed (region injected into the REST answers because 0016 is not live). Shots `docs/features/8-thailand`
  (`after/` = Thailand light + dark at 390px; `il/before` from main vs `il/after` from the branch for the Israeli household — before-shots lack dark by design,
  and the fonts differ because of the worktree junction).
- **DONE live 28.10 with Elad's OK:** migration 0016 applied (`db.mjs status` lists it; Israeli households keep region IL). `npx playwright test` against the
  live DB: 27 passed (Israel 19 + Thailand 8), 12 skipped.
- **NOT deployed:** the Edge Functions (`capture`, `extract-statement`, `submit-receipts`, `poll-batches`, `analyze-month`, `fx-rates`). `functions deploy` answered 401
  "Invalid access token" — the PAT in `.env.local` is dead (revoked/expired). Safe meanwhile: the OLD functions send the same RPC arguments (`svc_capture` keeps its
  signature), so Israeli households work; a Thai household needs the new functions. Next: Elad makes a new token, saves it in `.env.local`, then deploy the 6 and revoke it.
  SETUP "אזור תאילנד".
- Open (cannot be closed without real samples): the actual export format of each Thai bank (only generic English / Thai header aliases, Buddhist years and a
  windows-874 fallback exist); Thai merchant rules were written from public brand names, not from a real statement; the fx source mix (USD/EUR come from the
  Bank of Israel, THB from the ECB); a household that already holds data cannot switch region.
- Next: Elad makes a new token so the functions can deploy, uses an empty household, sets הבית → אזור → תאילנד, then sends one real Thai statement (CSV/XLSX) so the importer can be checked.

## ▶ HANDOFF (2026-10-28, session 8 — new app logo) — next session starts here
Branch `claude/new-logo` (from origin/main ddbfbb0, includes trip mode + neighborhood). One commit, no push by Claude.
- Built: new mark in `scripts/icons.mjs` (`master()`) → all PNGs re-rendered with `node scripts/icons.mjs`; `markArt()` in `src/ui/art.ts` is the
  same drawing (flat colors, theme accent tile). DECISIONS #41, ASSETS row updated. No migration, no Edge Function, nothing touches the DB or server.
- Checks: `npm test` 331 · typecheck · build · scan · `npx playwright test` 19 passed (12 skipped = SHOTS-only). Shots in `docs/features/7-logo`
  (`before/` = icon + splash from main; `after/` = icon, splash, login screen light + dark at 390px).
- Not verified: how the icon looks on a real iPhone home screen (iOS rounds the corners itself, the maskable/apple-touch ones are full-bleed);
  an already-installed copy keeps the OLD icon until it is deleted and added again to the home screen.
- Cost: icon PNGs got bigger (gradients), precache 1175 → 1361 KiB.
- Waiting on Elad: push `claude/new-logo`, PR, merge; optional: tell the family to re-add the app to see the new icon.

## ▶ HANDOFF (2026-10-27, session 7 — next-features §6 "השכונה שלנו")
Branch `claude/our-neighborhood` (cut from origin/main eeb3d83; on 27.10 origin/main with trip mode, PR #1, was merged in — the only
conflicts were DECISIONS rows #39/#40 and the PROGRESS HANDOFF blocks, kept both). Code-wise the two features are independent.
- Built: `src/domain/hood.ts` (kinds, floors, plots — pure) · `src/ui/hood.ts` (isometric SVG + the card) · `.hb-*` in design.css ·
  card in `overview.ts` after the hero · DECISIONS #40 · ASSETS row · next-features §6 marked done. For a finished budget month the
  card reads "השכונה של <חודש> · סיכום החודש". No migration, no Edge Function, nothing deployed, nothing touches the DB or the server.
- Checks: `npm test` 303 (unit/hood 8 new) · typecheck · build · scan · `npx playwright test` 16/16 (hood.spec 2 new: card light + dark,
  a building opens that category's transactions, no sideways scroll at 390px). Bundle: JS +1.5 KB gz, CSS +0.4 KB gz (budget 15 KB).
- Shots in `docs/features/6-neighborhood` (390px): `before/overview(.png|-dark.png)` (same branch with the card line removed),
  `after/overview(.png|-dark.png)` full page, `after/hood-card(.png|-dark.png)` the card alone (nav/FAB hidden for the crop).
- Caught while building: the legend reused `.dlegend` → an existing E2E (design.spec) found two matching buttons → own class `.hoodleg`;
  the gable roof first looked hollow → drawn with the back slope.
- Not verified: the month-end wording on a real finished month (the fixture only has the current month); a household with all 21
  categories at once on a phone (unit-tested markup only).
- Waiting on Elad: merge the `claude/our-neighborhood` PR after he pushes the merge commit; revoke the Supabase token (PR #1 is merged).
- Next: iPhone check of trip mode + this card; nothing else is left in next-features.md.

## ▶ HANDOFF (2026-10-27, session 6 — next-features §5 trip mode)
Branch `claude/trip-mode` (from origin/main eeb3d83). Commits: 33cb906 (§5 code) · b48c1bb (E2E fix ₪ label + 390px shots) · next commit (deploy recorded).
- Built: 0015 (tx original_amount/original_currency/fx_rate, settings trip_mode/trip_currency, `fx_rates` + `fx_meta` shared cache,
  `fx_overrides` manual rate per household, receipts/capture/apply_statement convert + keep the original), Edge Function `fx-rates`
  (Bank of Israel + ECB cross rates — BoI has NO THB; daily cache, retry after 30 min, stale fallback, 502 → "manual rate"), UI card
  "מצב טיול" in Home, manual add in the trip currency with live "≈ ₪", original + rate on every foreign row, matcher ±5% for foreign rows.
  DECISIONS #39, SECURITY row, SETUP "מצב טיול".
- Checks: `npm test` 323 (rls/fx 8, functions/fx 13, unit/fx 6, capture updated) · typecheck · check:functions 12 · build · scan ·
  rls/fx + rls/capture also on the LIVE DB (rolled-back txn) 17/17 · `npx playwright test` 29/29 (trip.spec 3 new; it caught "סכום (ILS)"
  instead of "סכום (₪)" → fixed) · shots in `docs/features/5-trip-mode` (before: home/add/tx from main; after: home, add, tx, add-trip,
  home-trip-card). Before-shots were taken from a worktree with a node_modules junction → Vite refused the fonts there (fallback font).
- **DONE live with Elad's OK (27.10):** 0015 applied.
- **DONE 27.10 (2nd token):** `fx-rates`, `capture`, `poll-batches`, `submit-receipts`, `extract-statement` deployed. Live check
  (synthetic fixture, removed after): 200, both sources fetched, 32 currencies (THB 0.091108 ecb · USD 3.078 boi · EUR 3.4462 boi ·
  JPY 0.019557 boi, dated 26.10 — BoI publishes ~13:30 Israel); 2nd call = cache; no session = 401. The first token was rejected
  (401) because it never got saved to `.env.local`.
- **Waiting on Elad:** send `claude/trip-mode` to GitHub + merge; revoke the Supabase token.
- Next: iPhone check — trip mode on, quick add (Back Tap) in ฿, an Apple Pay payment abroad → "מה נקלט ומתי" shows ₪ + ฿.
  §6 "השכונה שלנו" is the only feature left (optional).
- Not in scope / later: local Excel/CSV imports don't read an original-currency column; Hebrew wording of the trip card on a real iPhone.
- Known: commit 33cb906's message says "unit/fx 7" — it is 6.

## ▶ HANDOFF (2026-10-27, session 5 — next-features 3 → 5)
Branch `claude/next-features-3-5` (from origin/main 804f2e9). Commits: 0e49cd2 (§3 boundary tests on the OLD behavior, green) ·
1b1b3a0 (§3 code) · bbf8302 (§4 code). `npm test` 295 · typecheck · build · scan all green.
**DONE 27.10 with Elad's OK:** 0013 + 0014 applied live · rls/month + rls/vouchers also green on the live DB (rolled-back txn) ·
before-shots from a clean main worktree, after-shots from the branch (`docs/features/3-month-start`, `4-vouchers`, all 390px) ·
`npx playwright test` 14/14 · E2E caught the yearly table widening the plan tab to 545px → fixed (eac3e0e). Fixture now has
2 budgets + a sample voucher. Commits eac3e0e (§3 shots + fix) · 1ffbdab (§4 shots). Push to main: see the session-5 report.
How to take before-shots again: `git worktree add ../hb-before origin/main`, junction node_modules, copy .env.local + the
current tests/e2e/live.ts, run `SHOTS=before SHOTS_DIR=<abs path in this repo>/docs/features/<n> npx playwright test screens`,
then `git worktree remove --force ../hb-before`.
**§5 (trip mode) not started.** Needs: migration 0015 (tx original_amount/original_currency/fx_rate, fx cache table, household
"trip mode" + default currency), Edge Function `fx-rates` (Bank of Israel representative rates, cached daily, manual override,
fallback when down) → needs a NEW Supabase access token from Elad for the deploy (ask in ONE message, 5-year-old steps), then
"אפשר לבטל את הטוקן". Also give the function `[functions.fx-rates] verify_jwt = false` in supabase/config.toml (lesson from §1/§2).
§6 skipped unless there is room.

## ▶ HANDOFF (2026-10-26, session 3 — next-features.md)
Order: next-features.md §1 → 2 → 3 → 4 → 5 → (6 only if room). One feature = one commit, migrations from 0010,
tests green, before/after at 390px in `docs/features/<n>-<name>/` (`SHOTS=before|after SHOTS_DIR=… npx playwright test screens -g …`).

| # | Feature | Status |
|---|---|---|
| 1 | "איפה הכי זול?" (SuperMCP) | ✅ committed — migration 0010 **applied live**; Edge Function `price-compare` **deployed + checked live** (real SuperMCP answer, 8 stores, cache hit) |
| 2 | Apple Pay / Back Tap capture | ✅ committed — migration 0011 **applied live**; Edge Function `capture` **deployed + checked live** (shortcut-style call → saved; repeat → duplicate) |
| 3 | Budget month start + "כמה נשאר להיום" | ✅ 0e49cd2 (tests first) · 1b1b3a0 · eac3e0e — 0013 **live**, shots + E2E green |
| 4 | Vouchers wallet | ✅ bbf8302 · 1ffbdab — 0014 **live**, shots + E2E green |
| 5 | Trip mode / foreign currency | ✅ 33cb906 · b48c1bb — 0015 **live**; `fx-rates` + 4 functions **deployed + checked live** |
| 6 | "השכונה שלנו" | optional |

**Feature 1 notes:** REST API (`/openapi.json`), terms + privacy reviewed → DECISIONS #34 (credit shown, 10/day/household,
6h cache, only item names + chosen city/street leave the server). UI `src/ui/price.ts` replaces the static links card
(links stay as fallback). Tests: functions/price (8, mocked ok/partial/down/cache/rate/need-city/similar), rls/price (2),
e2e/price (2, function intercepted). Live check after deploy: `node scratch/smcp.mjs` style call through the function.
Also from an earlier side session: 0009 date_sanity (live) + month-selection guard on statement upload (b78ec0d, 764a686).

**Feature 2 notes:** per-user capture token `hbc_…` (shown once, sha256, rotate/revoke) → `svc_capture` scopes it to its
user + household while they can write; 2-min dedup; card by label/issuer/last4 else default card (quick → cash); wallet rows
`awaiting_statement` (merged by the statement import, RLS test proves it); category RULES moved to
`supabase/functions/_shared/rules.ts` (app re-exports). Guide in Home ("קליטה אוטומטית באייפון") + SETUP.md; new tab
"מה נקלט ומתי" (`capture_log`, 50 rows, any source). Hebrew iOS labels in the guide (ארנק, הפעלה מיידית…) were written from
the English names — check them on the real iPhone and fix wording if Apple's Hebrew differs. DECISIONS #35, SECURITY row.
Tests: rls/capture 8, functions/capture 7, e2e/capture 1 (cleans its rows — the smoke test counts exactly one review item).
After deploying `capture`: create a code in the app and run one real Apple Pay payment → check "מה נקלט ומתי".

**Branch:** all of this is on `claude/receipt-date-bug` (4 commits ahead of `main`, fast-forward) — NOT on main. Push that branch → PR → merge.
**All 11 Edge Functions deployed 2026-10-26** with Elad's new token (incl. the date-anchor prompts from 764a686). Lesson: a new function MUST get
`[functions.<name>] verify_jwt = false` in `supabase/config.toml` (we verify inside) — otherwise the gateway answers 401 before our code runs.
**Waiting on Elad:** push the branch + merge; revoke the Supabase token (deploy is done).
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
