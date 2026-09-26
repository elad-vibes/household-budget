# DECISIONS

Decisions made during the autonomous build, with the reason. Newest at the bottom.

| # | Decision | Why |
|---|---|---|
| 1 | Vanilla TypeScript + Vite (no Preact) | The prototype is template-string UI; a straight typed port keeps the UX/copy identical and the bundle small. An auto-escaping `html` tagged template replaces manual `esc()`. |
| 2 | RLS tests run on **PGlite** (Postgres 18 in WASM) with a Supabase auth/roles shim | No Docker on this ARM64 Windows machine. Same migrations, same `set role authenticated` + JWT claims as PostgREST. The suite can also be pointed at the live DB. |
| 3 | `people` table separate from `household_members` | The prompt needs people without a login (kids). Members = logins + roles; people = who an expense belongs to. `person_id = null` means "משותף" (joint), like the prototype. |
| 4 | Composite FKs `(household_id, id)` | Makes it impossible to reference a person/job from another household, independent of RLS. |
| 5 | Quotas live in `household_settings` but are protected by **column-level grants** | Members can change theme/send mode; only the super-admin RPC can change `quota_*`. |
| 6 | Reserve-then-finalize usage ledger with a row lock on the global cap | Enforces quotas *before* the API call without races; real cost recorded after. |
| 7 | E-mail contains a magic link **and** a 6-digit code | iOS home-screen apps don't share storage with Safari; a code typed in the PWA always works. PKCE flow for the link (URL fragment is free for the hash router). |
| 8 | Sign-ups disabled; invite accepted via `invite-signin` Edge Function + `accept_invite` RPC; invite bound to the first e-mail that uses it | "No public sign-up" and a leaked link can create at most one account. |
| 9 | New households are created by the super-admin (owner-invite link) | Prevents users multiplying their AI quota by creating households. Admin can only issue an owner invite for a household with **no** members, so they can never enter a family's data. |
| 10 | Google sign-in not implemented | Optional in the prompt; OAuth redirects also break inside iOS home-screen apps. |
| 11 | Statement PDFs are sent to Claude as a `document` block (no pdf.js) | Simpler, keeps the text layer; PDF limit 5MB like images. |
| 12 | Analysis prompt is built on the client from the month summary (as in the prototype) and sent to `analyze-month` | Reuses the prototype logic; the function wraps it in a fixed prompt, enforces structured JSON output and filters links to the whitelist. A user can only influence their own household's analysis. |
| 13 | Git author = GitHub noreply address | The repo is public; keeps the personal e-mail out of commit metadata. |
| 14 | Live DB migrations via `scripts/db.mjs` over the IPv4 session pooler with the DB password | No personal access token yet; the Management API (link/secrets/functions) needs one. Tracking table is the CLI's `supabase_migrations.schema_migrations`, so the CLI stays compatible later. |
| 15 | MFA enforced with **restrictive** RLS policies (`mfa_gate`) + `is_owner()`/`is_super_admin()` requiring `aal2` | Restrictive policies AND with the existing ones, so no finished policy had to be rewritten. Households/roster/settings stay readable at aal1 so the app can say "enter your code". |
| 16 | MFA required when: owner, super-admin, user has any verified factor, or household `require_mfa` | Matches the addendum; a half-finished (unverified) enrollment never locks a user out. |
| 17 | Own recovery codes (10, sha256 of `user_id:CODE`, single use) instead of Supabase's built-in ones | Supabase's recovery codes exist but are marked experimental and need server-side enablement. Ours: using a code (Edge Function `mfa-recover`) removes the lost TOTP factor, the user re-enrolls. |
| 18 | Owner MFA reset: only for non-owner members of the same household, never the super-admin | Owner↔owner resets would let one owner weaken another's account. |
| 19 | Sessions stay long-lived (Supabase refresh tokens, localStorage) | Family members are not asked for a code on every open; a new device or sign-out asks again. |
| 20 | Categorization rule order: the pharmacy rule runs before the grocery rule | Bug found by the parser tests: in the prototype "סופר פארם" matched "סופר " and was filed as groceries. Everything else in RULES is unchanged. |
| 21 | Pre-commit scan in Node (not Python), with a separate **commit-msg** hook | One toolchain for the repo. The hub scans `.git/COMMIT_EDITMSG` from pre-commit, which at that moment still holds the *previous* message; a commit-msg hook scans the real one. |
| 22 | Real-name denylist is local (`.scan-denylist.txt`, built from the live DB by `npm run scan:names`) | Names of real families must never be written into the repo, not even into the scanner's list. `scan-ok` on a line = reviewed synthetic example. |
| 23 | Import aliases per issuer + a "signed amount" mode (Discount's single "זכות/חובה" column) | Loud column checks need explicit aliases; the signed column is how Discount exports look. |
| 24 | Commit messages in Hebrew from here on (מה שונה · למה · מה נבדק) | Mirrors hub AGENTS.md. Earlier commits stay in English. |
| 25 | `docs/design-pass/**` added to the `.gitignore` allow-list (PNG screenshots) | Requested by design-brief.md (before/after at 390px). Screenshots come only from `tests/e2e/screens.spec.ts` on the synthetic live fixture (`example.test` users, invented merchants) — never real family data. |
