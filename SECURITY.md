# SECURITY — review of every RLS policy and Edge Function

Reviewed 2026-09-26 at the end of the build. Findings marked **FIXED** were fixed in this run
(commits `35deda9`, `7564e3b`, `487108d`, `dcd7192`); **OPEN** items need an action by the project owner.

## 1. Database (RLS) — `supabase/migrations/0001–0006`
Proven by 92 RLS tests that run both on PGlite and on the **live** database (`tests/rls/*.test.ts`).

| Table | RLS | Read | Write | aal2 gate | Notes |
|---|---|---|---|---|---|
| households | on | members | owner: rename only (column grant) | update | create/delete only via RPC |
| profiles | on | self + co-members | self | — | |
| household_members | on | members | — (RPCs only) | — | readable at aal1 so the app can ask for the code |
| people | on | members | owner/member; `user_id` not updatable; people with a login not deletable | all | |
| invites | on | owners (hash only) | RPCs | all | single use, 7 days, bound to first e-mail, token stored as sha256 |
| household_settings | on | members | theme/send mode only (column grants); `quota_*`/`require_mfa` via RPC | update | |
| transactions | on | members | owner/member; `created_by = auth.uid()`; `household_id`/`receipt_job_id` not updatable | all | composite FK to people/jobs of the **same** household |
| fixed_expenses, shopping_items, analyses | on | members | owner/member | all | |
| receipt_jobs, usage_ledger | on | members | service role only | all | |
| budgets, annual_expenses, savings_goals, suggestion_dismissals | on | members | owner/member | all | |
| goal_deposits | on | members | owner/member, `created_by = auth.uid()` | all | composite FK to goals |
| payment_methods | on | members | owner/member (column grants on update) | all | `last4` only (`^[0-9]{4}$`), never a full card number; composite FK to people; tx/fixed reference it by composite FK |
| receipt_items, budget_alerts | on | members | service/trigger (delete for items) | all | |
| push_subscriptions, notification_prefs | on | own rows | own rows; subscribing needs aal2 if you have a factor | — | |
| notification_queue, app_admins, app_config, rate_limits, mfa_recovery_codes | on | **nobody** | service / definer RPCs | — | |
| (RPC) stats_snapshot (0012) | — | role `hb_stats` only (not anon/authenticated/service/super-admin) | — | — | aggregates only (counts, USD, cron health); households by ordinal; `hb_stats` has no table privileges — proven by tests/rls/stats.test.ts |

Other checks: `anon` has no table privileges at all; `authenticated` only explicit grants; all SECURITY DEFINER
functions pin `search_path = ''`; `svc_*` executable by `service_role` only; admin RPCs require `app_admins` **and** aal2.

## 2. Edge Functions — `supabase/functions/_shared/handlers`
Every function: CORS allow-list (app origin + localhost), POST only, body size limit, JWT verified in code
(`auth.getClaims`), membership + role + the same MFA rule as RLS (`svc_access`), input validation, per-user
rate limit, **quota reserved before any Claude call** (released on failure, finalized with real usage), and
payload-free logging (tested: logs never contain file data or merchant names).

| Function | Auth | Validation | Notes |
|---|---|---|---|
| invite-signin | public | 64-hex token, e-mail format | IP + per-token rate limit; creates the auth user only after binding the invite to the e-mail |
| extract-statement | member/owner (not viewer) | ≤6 images or 1 PDF, jpeg/png/webp/pdf by **magic bytes**, ≤5MB | nothing stored; structured JSON output; categories re-validated |
| submit-receipts | member/owner | ≤10 images, magic bytes, ≤5MB, unique client ids | images inline in one Message Batch; **not stored** server-side |
| poll-batches | cron secret (constant-time compare) | — | results sanitized; batch **deleted at Anthropic** after saving |
| analyze-month | member/owner | month format, summary ≤14k chars | summary wrapped as data; links limited to the whitelist by schema **and** sanitizer |
| delete-account | signed in (+aal2 if a factor exists) | confirm word | refuses if owner of a shared household (transfer first) |
| price-compare | member (incl. viewer) at the household MFA level | household id; `similar` ≤60 chars | sends only item names/qty + chosen city/street to SuperMCP; 10/day/household (+40 similar), 6h cache, 20s timeout, https-only links in the result |
| capture | **capture token** (not a session; X-Capture-Token header), no Origin needed | amount parsed (₪/,/.), ≤100k, kind wallet/quick, category from the fixed list | 60/h per token + 120/h per IP; scoped in SQL to the token's user + household while they can write; 2-min dedup; token hashed, rotate/revoke in Home |
| (RPC) apply_statement, merge_statement_row | writer of the household (security invoker: RLS + column grants apply) | method must belong to the household; merges only waiting rows, else `match_stale` rolls back everything | one transaction |
| mfa-recover | signed in | code length | 5/hour; hashed single-use codes; removes lost factors → re-enroll |
| mfa-reset | owner at aal2 | uuids | only non-owner members of the same household, never the super-admin |
| notify | cron secret / signed-in (test) | — | pushes only to known push services |

## 3. Findings
| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | Rate-limit key trusted the first `X-Forwarded-For` entry (client-controlled) | **FIXED** — `cf-connecting-ip` / last hop (test added) |
| 2 | Medium | Receipt images/results stayed at Anthropic for 29 days after parsing | **FIXED** — `batches.delete` after results are saved (test added) |
| 3 | Medium | A crafted push endpoint could make `notify` POST to any URL (SSRF) | **FIXED** — allow-list of push services + `https` check in the DB |
| 4 | Low | Push subscription could be created at aal1 by a user who has a factor (amounts appear in notifications) | **FIXED** — `personal_mfa_ok()` in the insert policy (test) |
| 5 | Low | Pre-commit e-mail regex broken by a stray control character in one commit | **FIXED** in `487108d` |
| 6 | High until set up | Supabase Auth still had default settings: public sign-up enabled, built-in mailer | **FIXED 2026-09-27** (verified via the Management API: `disable_signup`, OTP template, TOTP on, SMS off, Brevo SMTP). Was: run `node scripts/setup-remote.mjs` after adding `SUPABASE_ACCESS_TOKEN` (sets `disable_signup`, OTP template, TOTP on, SMS off, SMTP). Data is still safe meanwhile: a stranger's account has no household, so RLS returns nothing. |
| 7 | Info | A leaked invite link can be used by whoever opens it first | Accepted — single use, 7 days, owner sees the claimed e-mail and can revoke; links are shared privately |
| 8 | Info | The Supabase project owner has technical access to all data | Accepted and stated in README |
| 9 | Info | Sessions live in `localStorage` (supabase-js standard) | Mitigated by CSP `script-src 'self'`, auto-escaping templates, no third-party scripts; "sign out on all devices" button |
| 10 | Info | Receipt images queued on a shared device remain in IndexedDB after sign-out | Accepted — per-household, deleted after parsing; device lock recommended |

## 4. Frontend
CSP meta (build): `default-src 'self'; script-src 'self'`; `connect-src` only the Supabase project; no inline
scripts or event handlers (event delegation); every template value escaped by default (`html```), AI links rendered
only from the whitelist and only `https`; `referrer no-referrer`; HTTPS only (GitHub Pages + `upgrade-insecure-requests`);
the build refuses a secret key; CI checks the bundle for key patterns. Service worker precaches static files only — no API data.

## 4b. Admin dashboard (server)
`/srv/tools/bayit-admin/` on Elad's server, Caddy `basicauth` (bcrypt hash in the Caddyfile), `noindex`, `no-store`.
Built every 5 min by the `vibes` user's crontab; its only secret is the `hb_stats` password in
`/home/vibes/household-stats/.env` (chmod 600) — that role can call `stats_snapshot()` and nothing else.
No Supabase API key, service-role key or session ever reaches the page or the server (DECISIONS #36).

## 5. Repository
Allow-list `.gitignore`; pre-commit + commit-msg scan (secrets, card/ID/bank numbers, phones, e-mails, real names from a
local denylist, data exports); synthetic fixtures only in `tests/fixtures/`; `git ls-files` contains no data files.
