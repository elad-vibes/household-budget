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
