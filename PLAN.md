# PLAN — "הכסף של הבית" v2 (PWA + Supabase)

Private household-budget app for ≤10 Israeli families (≤30 users), installed as a
home-screen PWA from Safari/Chrome. Built from the single-file prototype
(`legacy/index.html`, which stays reachable at `/legacy/`).

## 1. Architecture

```
iPhone / Android (PWA, Hebrew RTL)                       GitHub Pages (static)
┌──────────────────────────────────────────────┐        elad-vibes.github.io/household-budget/
│ Vite + TypeScript (vanilla, no framework)    │  ◄──── built by GitHub Actions on push to main
│  • UI port of the prototype (cards, themes)  │        /legacy/ = old single-file version
│  • Excel/CSV parser (client side, SheetJS)   │
│  • Receipt camera → compress → blur check    │
│  • IndexedDB receipt queue (images on device)│
│  • Service worker: app shell + Web Push      │
└───────────────┬──────────────────────────────┘
                │ HTTPS (supabase-js, JWT from magic link / e-mail code)
┌───────────────▼──────────────────────────────────────────────────────────┐
│ Supabase (free tier)                                                      │
│  Auth: e-mail magic link + 6-digit code, sign-ups disabled (invite only)  │
│  Postgres: RLS on every table (default deny), SECURITY DEFINER RPCs       │
│  Realtime: shopping_items (shared shopping list), transactions            │
│  Edge Functions (Deno):                                                   │
│    invite-signin      public: invite info + create the invited account    │
│    extract-statement  statement photos/PDF → rows (Sonnet 5, sync)        │
│    submit-receipts    receipt images → Message Batch (Haiku 4.5, async)   │
│    poll-batches       cron */30: batch results → 'review' transactions    │
│    analyze-month      monthly analysis JSON (Sonnet 5, structured output) │
│    delete-account     full account deletion                               │
│    notify             cron: Web Push (weekly summary, bills, receipts,    │
│                       budget alerts), quiet hours respected               │
│  pg_cron + pg_net: schedules poll-batches and notify                     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ server-side only (ANTHROPIC_API_KEY lives in Supabase secrets)
                ▼
        Anthropic API (Messages + Message Batches)
```

Why vanilla TypeScript and not Preact: the prototype is built from template
strings + `esc()`. Porting it to typed modules keeps the look and copy
identical, keeps the bundle tiny, and a tagged `html\`\`` template now escapes
every interpolation by default (safer than the prototype's manual `esc`).

### Code layout
```
index.html                 Vite entry (CSP meta injected at build)
src/
  main.ts                  boot, auth gate, router
  lib/        html.ts (auto-escaping templates) · format.ts · supa.ts · store.ts
              idb.ts (IndexedDB) · image.ts (compress + blur) · push.ts
  domain/     categories.ts (CATS/EXCL/RULES/THEMES/LINKS/SUBS) · parser.ts (localParse)
              tips.ts (localTips) · summary.ts · fixedSuggest.ts · budgets.ts · schedule.ts
  ui/         one module per screen (overview, add, tx, fixed, plan, shop, home, admin, auth, onboarding)
  sw.ts                    service worker (precache + push)
supabase/
  migrations/*.sql         schema, RLS, RPCs (applied in order)
  remote/*.sql             Supabase-only bits: realtime publication, pg_cron jobs
  functions/_shared/*.ts   pure, testable logic (runs in Deno and in Node/Vitest)
  functions/<name>/index.ts  thin Deno.serve wrappers
tests/  rls/ (PGlite) · unit/ (parser, blur, schedule…) · functions/ (mocked Anthropic) · e2e/ (Playwright 390px)
scripts/  setup-remote.mjs (migrations, auth config, secrets, functions deploy, first admin)
```

## 2. Data model

Every household-owned table carries `household_id`. Cross-table references use
**composite foreign keys** `(household_id, id)` so a row can never point at a
person/job of another household. Months are `YYYY-MM` in Israel time.

| table | purpose | who reads | who writes |
|---|---|---|---|
| households | name | members | owner renames; create/delete via RPC |
| profiles | display name per user | self + co-members | self |
| household_members | user ↔ household + role (owner/member/viewer) | members | RPCs only |
| people | assignable persons, with or without login (kids) | members | owner/member |
| invites | single-use hashed tokens, 7-day expiry, role, bound to first e-mail | owners | RPCs |
| household_settings | theme, receipt send mode, quotas | members | owner/member (theme+send mode only — column grants); quotas via admin RPC |
| transactions | date, month, merchant, amount numeric(12,2), category, is_fixed, note, person_id, source, status review/saved, created_by | members | owner/member |
| fixed_expenses | expected recurring charges + keyword matching | members | owner/member |
| shopping_items | shared list (realtime) | members | owner/member |
| analyses | AI analysis JSON per month | members | Edge Function (+ backup import) |
| receipt_jobs | one per Message Batch | members | service role |
| usage_ledger | reserved/final cost rows per AI call | members (own household) | service role |
| app_admins / app_config / rate_limits | super-admin list, global cap, rate limits | nobody (RLS on, no policies) | service role / definer RPCs |

Phase 2 adds: `budgets`, `budget_alerts`, `push_subscriptions`, `notification_prefs`,
`notification_queue`, `receipt_items` (price history), `annual_expenses`,
`savings_goals`, `goal_deposits`, `suggestion_dismissals`.

The **full SQL** (tables, RLS policies, grants, RPCs) is in the appendix below and
is the exact content of `supabase/migrations/`.

## 3. RLS policy model

* `enable row level security` on **every** table; no policy ⇒ no access.
* Helpers (SECURITY DEFINER, `search_path=''`): `is_member(hh)`, `can_write(hh)`
  (owner/member), `is_owner(hh)`, `is_super_admin()`.
* Read = `is_member`; write = `can_write`; viewers read only.
* `anon` has no table privileges at all; `authenticated` gets explicit
  table/column grants (e.g. settings quotas and `household_id` are not updatable).
* Insert checks pin `created_by = auth.uid()`; composite FKs pin references.
* The super-admin is **not** a member of other households, so RLS hides all money
  data from them; `admin_overview()` returns usage/quotas/cost only.
* `svc_*` functions are executable by `service_role` only.

Proven by `tests/rls/rls.test.ts` (runs the real migrations on PGlite with a
Supabase auth shim; can also run against the live DB).

## 4. Auth & invites

* Supabase Auth, e-mail OTP. The e-mail contains **both** a magic link and a
  6-digit code: on iPhone the home-screen app has separate storage from Safari,
  so a link opened from Mail cannot sign the PWA in — the code can.
* Public sign-ups are disabled. Joining: owner creates an invite (role + name) →
  link `…/#/join/<token>` → invitee enters e-mail → `invite-signin` binds the
  invite to that e-mail and creates the auth user (admin API) → the app sends the
  sign-in e-mail → after sign-in `accept_invite(token)` adds the membership.
* New household: the super-admin runs `admin_create_household(name)` from the
  admin screen and sends the owner-invite link to the family.

## 5. Edge Functions (all: CORS limited to the app origin, JWT verified inside,
membership checked, inputs validated, per-user rate limit, no payload logging)

| function | auth | input limits | model / mode | quota kind |
|---|---|---|---|---|
| invite-signin | public (IP rate-limited) | token + e-mail | — | — |
| extract-statement | member/owner | ≤6 images or 1 PDF, jpeg/png/webp/pdf, ≤5MB each | claude-sonnet-5, sync, JSON schema | statement |
| submit-receipts | member/owner | ≤10 images/call, jpeg/png/webp, ≤5MB each | claude-haiku-4-5, **Message Batches** | receipt (per image) |
| poll-batches | cron secret | — | batch results | finalizes cost |
| analyze-month | member/owner | summary ≤14k chars | claude-sonnet-5, JSON schema | analysis |
| delete-account | signed-in user | confirm phrase | — | — |
| notify (Phase 2) | cron secret | — | — | — |

Quota enforcement: before every Anthropic call the function calls
`svc_reserve_usage` which (under a row lock) checks per-household monthly limits
for images / statements / analyses / USD and the global monthly USD cap, then
writes a `reserved` ledger row with the estimated cost. After the call the row is
finalized with the real `usage` × price (batches at 50%). Errors release it.

## 6. Receipt batch data flow

```
camera/file ─► compress (~1.2MP JPEG) ─► blur check (Laplacian variance) ─► warn/retake
            ─► IndexedDB {id, household, person, blob, status:queued}
send mode: immediate | weekly (day) | monthly (date) | "send now";
auto-send on the first app open after the scheduled time
            ─► POST submit-receipts (≤10 per call, base64)
               verify JWT + role ─ validate mime/size/count ─ rate limit ─ reserve quota
               ─► anthropic.messages.batches.create (one request per receipt,
                  custom_id = client id, image inline, structured JSON output)
               ─► receipt_jobs row (batch id, items) — NO image stored server-side
device: status=submitted (image kept until parsed)
pg_cron */30 ─► poll-batches ─► batches.retrieve → when ended: batches.results
               ─► svc_complete_receipt_job: 'review' transactions (+ line items),
                  finalize usage with real tokens × price × 0.5
app open ─► "X קבלות מחכות לאישור" ─► review / approve
device: receipts whose job ended are deleted locally unless "keep for warranty"
```

## 7. Monthly cost estimate (10 households)

Assumptions per household per month: 40 receipts, 2 statements (3 photos each),
2 analyses. Image ≈1.2MP ≈ 1,600 input tokens. Prices (per 1M tokens):
Haiku 4.5 $1 in / $5 out (batch −50%), Sonnet 5 $2 in / $10 out.

| item | tokens (in/out) | unit cost | per household | 10 households |
|---|---|---|---|---|
| receipt (batch Haiku) | 2,200 / 400 | $0.0021 | 40 × = $0.084 | $0.84 |
| statement (Sonnet 5) | 5,800 / 4,000 | $0.052 | 2 × = $0.10 | $1.04 |
| analysis (Sonnet 5) | 2,500 / 3,000 | $0.035 | 2 × = $0.07 | $0.70 |
| **total AI** | | | **≈ $0.26** | **≈ $2.60 / month** |

Heavy use (3×) ≈ $8/month. Supabase free tier, GitHub Pages and an SMTP free tier
(e.g. Brevo 300 e-mails/day) cost $0. Default quotas: 150 images, 10 statements,
8 analyses, $3 per household; global cap $30/month (all adjustable by the super-admin).
Also set a hard monthly spend limit in the Anthropic Console (SETUP.md).

## 8. Security summary
RLS default deny + tests; JWT + membership + validation + rate limit in every
function; Anthropic key server-side only; no payload/PII logging; CORS pinned to
the app origin; CSP meta on the frontend (self + Supabase only); HTTPS only;
account deletion and full household deletion; README states that the Supabase
project owner has technical DB access. Details and review findings: SECURITY.md.

## 9. Order of work
Phase 1: schema+RLS+tests → auth+invites → UI port → Excel/CSV → statements →
receipt queue+batches → quotas+admin → backup/import → PWA+onboarding → deploy.
Phase 2: budgets → Web Push → price history → annual calendar → savings goals →
fixed-expense suggestions → redeploy. Final: security review, 390px check, Lighthouse.

---

## Appendix — full schema SQL (`supabase/migrations/`, exact copies)

### supabase/migrations/0001_core.sql

```sql
-- ============================================================================
-- 0001_core.sql — tables for "הכסף של הבית" (household budget)
-- Every table gets RLS in 0002_rls.sql (default deny).
-- ============================================================================

create type public.member_role as enum ('owner', 'member', 'viewer');

-- ---------------------------------------------------------------- households
create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now()
);

create table public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 40),
  created_at    timestamptz not null default now()
);

create table public.household_members (
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.member_role not null,
  joined_at     timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members (user_id);

-- People you can assign expenses to. A person may or may not have a login
-- (kids, a grandparent without a phone...).
create table public.people (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 30),
  user_id       uuid null references auth.users (id) on delete set null,
  sort          integer not null default 0,
  archived      boolean not null default false,
  legacy_key    text null check (char_length(legacy_key) <= 20),
  created_at    timestamptz not null default now(),
  unique (household_id, id)
);
create index people_household_idx on public.people (household_id);

create table public.invites (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  token_hash     text not null unique,
  role           public.member_role not null default 'member',
  person_name    text null check (char_length(person_name) <= 30),
  created_by     uuid null references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  claimed_email  text null,
  used_at        timestamptz null,
  used_by        uuid null references auth.users (id) on delete set null,
  revoked_at     timestamptz null
);
create index invites_household_idx on public.invites (household_id);

-- ------------------------------------------------------ settings & quotas
create table public.household_settings (
  household_id      uuid primary key references public.households (id) on delete cascade,
  theme             text not null default 'max'
                    check (theme in ('max','isracard','cal','leumi','hapoalim','discount','mizrahi','neutral')),
  send_mode         text not null default 'weekly' check (send_mode in ('immediate','weekly','monthly')),
  send_weekday      smallint not null default 0 check (send_weekday between 0 and 6),   -- 0 = Sunday
  send_monthday     smallint not null default 1 check (send_monthday between 1 and 28),
  -- quotas: writable only by the super-admin RPCs (column grants in 0002)
  quota_images      integer not null default 150 check (quota_images >= 0),
  quota_statements  integer not null default 10  check (quota_statements >= 0),
  quota_analyses    integer not null default 8   check (quota_analyses >= 0),
  quota_usd         numeric(8,2) not null default 3.00 check (quota_usd >= 0),
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------ money data
create table public.receipt_jobs (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  submitted_by    uuid null references auth.users (id) on delete set null,
  batch_id        text not null,
  model           text not null,
  status          text not null default 'submitted'
                  check (status in ('submitted','ended','failed','canceled')),
  item_count      integer not null check (item_count between 1 and 50),
  -- [{client_id, person_id, status: submitted|parsed|unreadable|failed}]
  items           jsonb not null default '[]'::jsonb,
  reservation_id  uuid null,
  error           text null,
  created_at      timestamptz not null default now(),
  checked_at      timestamptz null,
  ended_at        timestamptz null,
  unique (household_id, id)
);
create index receipt_jobs_open_idx on public.receipt_jobs (status) where status = 'submitted';

create table public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households (id) on delete cascade,
  date               date not null,
  month              text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  merchant           text not null check (char_length(merchant) between 1 and 120),
  amount             numeric(12,2) not null,
  category           text not null check (char_length(category) between 1 and 40),
  is_fixed           boolean not null default false,
  note               text not null default '' check (char_length(note) <= 200),
  person_id          uuid null,
  source             text not null default 'manual'
                     check (source in ('manual','import','statement','receipt','backup')),
  source_title       text not null default '' check (char_length(source_title) <= 120),
  status             text not null default 'saved' check (status in ('review','saved')),
  receipt_job_id     uuid null,
  receipt_client_id  text null check (char_length(receipt_client_id) <= 64),
  created_by         uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (household_id, id),
  -- composite FKs keep every reference inside the same household
  foreign key (household_id, person_id)
    references public.people (household_id, id) on delete set null (person_id),
  foreign key (household_id, receipt_job_id)
    references public.receipt_jobs (household_id, id) on delete set null (receipt_job_id)
);
create index transactions_household_month_idx on public.transactions (household_id, month);
create index transactions_review_idx on public.transactions (household_id) where status = 'review';

create table public.fixed_expenses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  amount        numeric(12,2) not null,
  keyword       text not null check (char_length(btrim(keyword)) between 1 and 40),
  category      text not null check (char_length(category) between 1 and 40),
  person_id     uuid null,                                   -- null = anyone
  cycle         smallint not null default 1 check (cycle in (1, 2, 12)),
  due_day       smallint null check (due_day between 1 and 31),
  note          text not null default '' check (char_length(note) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (household_id, person_id)
    references public.people (household_id, id) on delete set null (person_id)
);
create index fixed_expenses_household_idx on public.fixed_expenses (household_id);

create table public.shopping_items (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  qty           integer not null default 1 check (qty between 1 and 99),
  done          boolean not null default false,
  sort          bigint not null default 0,
  created_by    uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index shopping_items_household_idx on public.shopping_items (household_id);

create table public.analyses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  month         text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  data          jsonb not null,
  model         text not null default '',
  created_by    uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (household_id, month),
  check (pg_column_size(data) < 20000)
);

-- --------------------------------------------------------- usage & admin
-- One row per AI call (or per receipt batch). 'reserved' rows are written
-- BEFORE the Anthropic call and finalized with real token usage afterwards.
create table public.usage_ledger (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid null references public.households (id) on delete set null,
  user_id        uuid null references auth.users (id) on delete set null,
  kind           text not null check (kind in ('receipt','statement','analysis')),
  units          integer not null default 1 check (units >= 0),
  model          text not null default '',
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  usd            numeric(10,5) not null default 0,
  status         text not null default 'reserved' check (status in ('reserved','final','released')),
  ref            text null,
  month          text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index usage_ledger_month_idx on public.usage_ledger (month, household_id);

create table public.app_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.app_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
insert into public.app_config (key, value) values
  ('global_usd_cap', '30'::jsonb);

create table public.rate_limits (
  key           text not null,
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (key, bucket, window_start)
);

-- ------------------------------------------------------------- triggers
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();
create trigger fixed_touch before update on public.fixed_expenses
  for each row execute function public.touch_updated_at();
create trigger shopping_touch before update on public.shopping_items
  for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.household_settings
  for each row execute function public.touch_updated_at();

-- Every new household gets a settings row.
create function public.households_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.household_settings (household_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger households_settings after insert on public.households
  for each row execute function public.households_after_insert();

-- The current month, as the family sees it (Israel time).
create function public.local_month(ts timestamptz default now()) returns text
language sql stable set search_path = '' as $$
  select to_char(ts at time zone 'Asia/Jerusalem', 'YYYY-MM')
$$;
```

### supabase/migrations/0002_rls.sql

```sql
-- ============================================================================
-- 0002_rls.sql — Row Level Security. Default deny on every table:
-- RLS is enabled everywhere and access exists only where a policy grants it.
-- Service-role (Edge Functions) bypasses RLS by design.
-- ============================================================================

-- ------------------------------------------------------- helper functions
-- SECURITY DEFINER so they can read household_members without recursing
-- into its own policies. search_path is pinned to '' (no hijacking).
create function public.is_member(hh uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = (select auth.uid())
  )
$$;

create function public.can_write(hh uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = (select auth.uid())
      and m.role in ('owner', 'member')
  )
$$;

create function public.is_owner(hh uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = (select auth.uid())
      and m.role = 'owner'
  )
$$;

create function public.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
$$;

-- --------------------------------------------------------- enable RLS
alter table public.households          enable row level security;
alter table public.profiles            enable row level security;
alter table public.household_members   enable row level security;
alter table public.people              enable row level security;
alter table public.invites             enable row level security;
alter table public.household_settings  enable row level security;
alter table public.receipt_jobs        enable row level security;
alter table public.transactions        enable row level security;
alter table public.fixed_expenses      enable row level security;
alter table public.shopping_items      enable row level security;
alter table public.analyses            enable row level security;
alter table public.usage_ledger        enable row level security;
alter table public.app_admins          enable row level security;   -- no policies: nobody
alter table public.app_config          enable row level security;   -- no policies: nobody
alter table public.rate_limits         enable row level security;   -- no policies: nobody

-- ------------------------------------------------------------ policies
-- households: members read; owners rename (column grant below); no direct
-- insert/delete (RPCs only).
create policy households_select on public.households
  for select to authenticated using (public.is_member(id));
create policy households_update on public.households
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

-- profiles: you see your own profile and those of people in your households.
create policy profiles_select on public.profiles
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.household_members m
      where m.user_id = profiles.user_id and public.is_member(m.household_id)
    )
  );
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- household_members: read your households' rosters. Changes only via RPCs.
create policy members_select on public.household_members
  for select to authenticated using (public.is_member(household_id));

-- people: everyone in the household reads; owners/members add & edit.
create policy people_select on public.people
  for select to authenticated using (public.is_member(household_id));
create policy people_insert on public.people
  for insert to authenticated with check (public.can_write(household_id) and user_id is null);
create policy people_update on public.people
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));
create policy people_delete on public.people
  for delete to authenticated using (public.can_write(household_id) and user_id is null);

-- invites: only owners see them (they are hashed anyway). Create/revoke via RPC.
create policy invites_select on public.invites
  for select to authenticated using (public.is_owner(household_id));

-- settings: members read; owners/members change theme & send mode
-- (column grants below keep quota_* out of reach).
create policy settings_select on public.household_settings
  for select to authenticated using (public.is_member(household_id));
create policy settings_update on public.household_settings
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));

-- receipt jobs: members read status; only the service role writes.
create policy receipt_jobs_select on public.receipt_jobs
  for select to authenticated using (public.is_member(household_id));

-- transactions / fixed / shopping: members read, owners+members write.
create policy tx_select on public.transactions
  for select to authenticated using (public.is_member(household_id));
create policy tx_insert on public.transactions
  for insert to authenticated with check (
    public.can_write(household_id) and created_by = (select auth.uid())
    and receipt_job_id is null
  );
create policy tx_update on public.transactions
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));
create policy tx_delete on public.transactions
  for delete to authenticated using (public.can_write(household_id));

create policy fixed_select on public.fixed_expenses
  for select to authenticated using (public.is_member(household_id));
create policy fixed_insert on public.fixed_expenses
  for insert to authenticated with check (public.can_write(household_id));
create policy fixed_update on public.fixed_expenses
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));
create policy fixed_delete on public.fixed_expenses
  for delete to authenticated using (public.can_write(household_id));

create policy shop_select on public.shopping_items
  for select to authenticated using (public.is_member(household_id));
create policy shop_insert on public.shopping_items
  for insert to authenticated with check (
    public.can_write(household_id) and created_by = (select auth.uid())
  );
create policy shop_update on public.shopping_items
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));
create policy shop_delete on public.shopping_items
  for delete to authenticated using (public.can_write(household_id));

-- analyses: members read; owners/members may import (backup) or delete.
-- New AI analyses are written by the analyze-month Edge Function.
create policy analyses_select on public.analyses
  for select to authenticated using (public.is_member(household_id));
create policy analyses_insert on public.analyses
  for insert to authenticated with check (public.can_write(household_id));
create policy analyses_update on public.analyses
  for update to authenticated using (public.can_write(household_id))
  with check (public.can_write(household_id));
create policy analyses_delete on public.analyses
  for delete to authenticated using (public.can_write(household_id));

-- usage: members may see their own household's usage vs quota (no personal data).
create policy usage_select on public.usage_ledger
  for select to authenticated using (household_id is not null and public.is_member(household_id));

-- ------------------------------------------------------------ privileges
-- Supabase grants ALL on public tables to anon/authenticated by default.
-- Tighten: anon gets nothing, authenticated gets only what the app uses.
revoke all on all tables in schema public from anon, authenticated;

grant select, update (name) on public.households to authenticated;
grant select, insert, update (display_name) on public.profiles to authenticated;
grant select on public.household_members to authenticated;
grant select, insert, delete on public.people to authenticated;
grant update (name, sort, archived) on public.people to authenticated;
grant select on public.invites to authenticated;
grant select on public.household_settings to authenticated;
grant update (theme, send_mode, send_weekday, send_monthday) on public.household_settings to authenticated;
grant select on public.receipt_jobs to authenticated;
grant select, insert, delete on public.transactions to authenticated;
grant update (date, month, merchant, amount, category, is_fixed, note, person_id, status)
  on public.transactions to authenticated;
grant select, insert, update, delete on public.fixed_expenses to authenticated;
grant select, insert, delete on public.shopping_items to authenticated;
grant update (name, qty, done, sort) on public.shopping_items to authenticated;
grant select, insert, update, delete on public.analyses to authenticated;
grant select on public.usage_ledger to authenticated;

grant all on all tables in schema public to service_role;
```

### supabase/migrations/0003_rpc.sql

```sql
-- ============================================================================
-- 0003_rpc.sql — server-side functions.
--   * user RPCs      (authenticated; check roles themselves)
--   * admin RPCs     (authenticated but require app_admins; usage only, never money data)
--   * svc_* RPCs     (service_role only — called by Edge Functions)
-- All are SECURITY DEFINER with search_path = '' and explicit grants at the end.
-- ============================================================================

create function public.token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

-- 244 random bits, url-safe hex
create function public.new_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- ================================================================ user RPCs
create function public.create_invite(
  p_household uuid, p_role public.member_role default 'member', p_person_name text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_active int;
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select count(*) into v_active from public.invites
   where household_id = p_household and used_at is null and revoked_at is null and expires_at > now();
  if v_active >= 20 then
    raise exception 'too_many_invites' using errcode = 'P0001';
  end if;
  v_token := public.new_token();
  insert into public.invites (household_id, token_hash, role, person_name, created_by)
  values (p_household, public.token_hash(v_token), p_role,
          nullif(left(btrim(coalesce(p_person_name, '')), 30), ''), auth.uid());
  return v_token;
end $$;

create function public.revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.invites set revoked_at = now()
   where id = p_invite and used_at is null and revoked_at is null
     and public.is_owner(household_id);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

create function public.accept_invite(p_token text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv    public.invites;
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_person uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_inv from public.invites where token_hash = public.token_hash(p_token) for update;
  if not found or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  if v_inv.used_at is not null then
    if v_inv.used_by = v_uid then
      return v_inv.household_id;              -- idempotent re-accept
    end if;
    raise exception 'invite_used' using errcode = 'P0001';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_inv.claimed_email is not null and v_inv.claimed_email is distinct from v_email then
    raise exception 'invite_other_email' using errcode = 'P0001';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (v_inv.household_id, v_uid, v_inv.role)
  on conflict (household_id, user_id) do nothing;

  v_name := left(coalesce(nullif(btrim(p_display_name), ''), v_inv.person_name,
                          split_part(coalesce(v_email, ''), '@', 1), 'אני'), 30);
  insert into public.profiles (user_id, display_name) values (v_uid, v_name)
  on conflict (user_id) do update
    set display_name = case when public.profiles.display_name = '' then excluded.display_name
                            else public.profiles.display_name end;

  if not exists (select 1 from public.people where household_id = v_inv.household_id and user_id = v_uid) then
    select id into v_person from public.people
     where household_id = v_inv.household_id and user_id is null and not archived
       and lower(btrim(name)) = lower(btrim(v_name))
     limit 1;
    if v_person is not null then
      update public.people set user_id = v_uid where id = v_person;
    else
      insert into public.people (household_id, name, user_id, sort)
      values (v_inv.household_id, v_name, v_uid,
              (select coalesce(max(sort), 0) + 1 from public.people where household_id = v_inv.household_id));
    end if;
  end if;

  update public.invites set used_at = now(), used_by = v_uid where id = v_inv.id;
  return v_inv.household_id;
end $$;

create function public.set_member_role(p_household uuid, p_user uuid, p_role public.member_role) returns void
language plpgsql security definer set search_path = '' as $$
declare v_owners int; v_cur public.member_role;
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select role into v_cur from public.household_members where household_id = p_household and user_id = p_user for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_cur = 'owner' and p_role <> 'owner' then
    select count(*) into v_owners from public.household_members where household_id = p_household and role = 'owner';
    if v_owners <= 1 then
      raise exception 'last_owner' using errcode = 'P0001';
    end if;
  end if;
  update public.household_members set role = p_role where household_id = p_household and user_id = p_user;
end $$;

-- Owners remove members; anyone may leave (p_user = self).
create function public.remove_member(p_household uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.member_role; v_owners int; v_members int;
begin
  if not (public.is_owner(p_household) or (p_user = auth.uid() and public.is_member(p_household))) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select role into v_role from public.household_members where household_id = p_household and user_id = p_user for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*), count(*) filter (where role = 'owner') into v_members, v_owners
    from public.household_members where household_id = p_household;
  if v_members = 1 then
    raise exception 'use_delete_household' using errcode = 'P0001';
  end if;
  if v_role = 'owner' and v_owners <= 1 then
    raise exception 'last_owner' using errcode = 'P0001';
  end if;
  delete from public.household_members where household_id = p_household and user_id = p_user;
  update public.people set user_id = null where household_id = p_household and user_id = p_user;
end $$;

-- Deletes the household and ALL its data (cascade). Owner only.
create function public.delete_household(p_household uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  delete from public.households where id = p_household;
end $$;

-- Usage of the current month vs quotas, for any member of the household.
create function public.household_usage(p_household uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; s public.household_settings; v_month text := public.local_month();
begin
  if not public.is_member(p_household) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  select * into s from public.household_settings where household_id = p_household;
  select jsonb_build_object(
    'month', v_month,
    'images', coalesce(sum(units) filter (where kind = 'receipt'), 0),
    'statements', coalesce(sum(units) filter (where kind = 'statement'), 0),
    'analyses', coalesce(sum(units) filter (where kind = 'analysis'), 0),
    'usd', round(coalesce(sum(usd), 0), 4),
    'quota_images', s.quota_images, 'quota_statements', s.quota_statements,
    'quota_analyses', s.quota_analyses, 'quota_usd', s.quota_usd)
  into v
  from public.usage_ledger
  where household_id = p_household and month = v_month and status <> 'released';
  return v;
end $$;

-- ================================================================ admin RPCs
-- The super-admin sees usage, quotas and cost per household. Never money data.
create function public.admin_overview(p_month text default null)
returns table (
  household_id uuid, name text, created_at timestamptz, members int, people int,
  images int, statements int, analyses int, usd numeric,
  quota_images int, quota_statements int, quota_analyses int, quota_usd numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare v_month text := coalesce(p_month, public.local_month());
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return query
  select h.id, h.name, h.created_at,
         (select count(*)::int from public.household_members m where m.household_id = h.id),
         (select count(*)::int from public.people p where p.household_id = h.id and not p.archived),
         coalesce(sum(u.units) filter (where u.kind = 'receipt'), 0)::int,
         coalesce(sum(u.units) filter (where u.kind = 'statement'), 0)::int,
         coalesce(sum(u.units) filter (where u.kind = 'analysis'), 0)::int,
         round(coalesce(sum(u.usd), 0), 4),
         s.quota_images, s.quota_statements, s.quota_analyses, s.quota_usd
  from public.households h
  join public.household_settings s on s.household_id = h.id
  left join public.usage_ledger u on u.household_id = h.id and u.month = v_month and u.status <> 'released'
  group by h.id, h.name, h.created_at, s.quota_images, s.quota_statements, s.quota_analyses, s.quota_usd
  order by h.created_at;
end $$;

create function public.admin_totals(p_month text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_month text := coalesce(p_month, public.local_month());
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month', v_month,
    'usd', (select round(coalesce(sum(usd), 0), 4) from public.usage_ledger where month = v_month and status <> 'released'),
    'cap', (select value from public.app_config where key = 'global_usd_cap'),
    'households', (select count(*) from public.households));
end $$;

create function public.admin_set_quotas(
  p_household uuid, p_images int, p_statements int, p_analyses int, p_usd numeric
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  update public.household_settings
     set quota_images = p_images, quota_statements = p_statements,
         quota_analyses = p_analyses, quota_usd = p_usd
   where household_id = p_household;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

create function public.admin_set_global_cap(p_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_usd is null or p_usd < 0 then
    raise exception 'invalid' using errcode = '22023';
  end if;
  update public.app_config set value = to_jsonb(p_usd), updated_at = now() where key = 'global_usd_cap';
end $$;

-- Creates an empty household and returns a single-use OWNER invite token.
create function public.admin_create_household(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text;
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  insert into public.households (name) values (left(btrim(p_name), 60)) returning id into v_id;
  v_token := public.new_token();
  insert into public.invites (household_id, token_hash, role, created_by)
  values (v_id, public.token_hash(v_token), 'owner', auth.uid());
  return jsonb_build_object('household_id', v_id, 'token', v_token);
end $$;

-- A fresh owner invite, only for households that have NO members (e.g. the
-- first invite expired). Never lets the admin into a family's data.
create function public.admin_owner_invite(p_household uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if exists (select 1 from public.household_members where household_id = p_household) then
    raise exception 'household_has_members' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.households where id = p_household) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_token := public.new_token();
  insert into public.invites (household_id, token_hash, role, created_by)
  values (p_household, public.token_hash(v_token), 'owner', auth.uid());
  return v_token;
end $$;

create function public.admin_delete_household(p_household uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  delete from public.households where id = p_household;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

-- ============================================================ service RPCs
-- Fixed-window rate limit. Returns true when the call is allowed.
create function public.svc_rate_limit(p_key text, p_bucket text, p_max int, p_window_secs int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_count int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into public.rate_limits as r (key, bucket, window_start, count)
  values (p_key, p_bucket, v_start, 1)
  on conflict (key, bucket, window_start) do update set count = r.count + 1
  returning count into v_count;
  delete from public.rate_limits where key = p_key and window_start < now() - interval '2 days';
  return v_count <= p_max;
end $$;

create function public.svc_member_role(p_household uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role::text from public.household_members where household_id = p_household and user_id = p_user
$$;

-- Checks quotas + the global cap and records a reservation atomically.
create function public.svc_reserve_usage(
  p_household uuid, p_user uuid, p_kind text, p_units int, p_est_usd numeric,
  p_model text default '', p_ref text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.household_settings;
  v_month text := public.local_month();
  v_units int; v_usd numeric; v_global numeric; v_cap numeric; v_quota int; v_id uuid;
begin
  -- serialize all reservations so the global cap cannot be overrun by a race
  perform 1 from public.app_config where key = 'global_usd_cap' for update;
  select * into s from public.household_settings where household_id = p_household for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_household');
  end if;
  select coalesce(sum(units) filter (where kind = p_kind), 0), coalesce(sum(usd), 0)
    into v_units, v_usd
    from public.usage_ledger
   where household_id = p_household and month = v_month and status <> 'released';
  v_quota := case p_kind when 'receipt' then s.quota_images
                         when 'statement' then s.quota_statements
                         when 'analysis' then s.quota_analyses end;
  if v_quota is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  if v_units + p_units > v_quota then
    return jsonb_build_object('ok', false, 'reason', 'quota_' || p_kind, 'used', v_units, 'quota', v_quota);
  end if;
  if v_usd + p_est_usd > s.quota_usd then
    return jsonb_build_object('ok', false, 'reason', 'quota_usd', 'used', v_usd, 'quota', s.quota_usd);
  end if;
  select coalesce(sum(usd), 0) into v_global from public.usage_ledger where month = v_month and status <> 'released';
  select (value #>> '{}')::numeric into v_cap from public.app_config where key = 'global_usd_cap';
  if v_global + p_est_usd > coalesce(v_cap, 0) then
    return jsonb_build_object('ok', false, 'reason', 'global_cap');
  end if;
  insert into public.usage_ledger (household_id, user_id, kind, units, model, usd, status, ref, month)
  values (p_household, p_user, p_kind, p_units, coalesce(p_model, ''), p_est_usd, 'reserved', p_ref, v_month)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'reservation_id', v_id);
end $$;

create function public.svc_finalize_usage(
  p_id uuid, p_units int, p_input int, p_output int, p_usd numeric
) returns void
language sql security definer set search_path = '' as $$
  update public.usage_ledger
     set status = 'final', units = coalesce(p_units, units), input_tokens = coalesce(p_input, 0),
         output_tokens = coalesce(p_output, 0), usd = coalesce(p_usd, usd), updated_at = now()
   where id = p_id
$$;

create function public.svc_release_usage(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.usage_ledger set status = 'released', updated_at = now() where id = p_id and status = 'reserved'
$$;

create function public.svc_record_receipt_job(
  p_household uuid, p_user uuid, p_batch_id text, p_model text, p_items jsonb, p_reservation uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_items jsonb;
begin
  -- keep only person ids that really belong to this household
  select coalesce(jsonb_agg(jsonb_build_object(
           'client_id', left(e->>'client_id', 64),
           'person_id', (select p.id from public.people p
                          where p.household_id = p_household and p.id::text = e->>'person_id'),
           'status', 'submitted')), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(p_items) e;
  insert into public.receipt_jobs (household_id, submitted_by, batch_id, model, item_count, items, reservation_id)
  values (p_household, p_user, p_batch_id, p_model, jsonb_array_length(v_items), v_items, p_reservation)
  returning id into v_id;
  return v_id;
end $$;

create function public.svc_open_receipt_jobs(p_limit int default 20)
returns setof public.receipt_jobs
language sql stable security definer set search_path = '' as $$
  select * from public.receipt_jobs
   where status = 'submitted'
   order by checked_at nulls first, created_at
   limit p_limit
$$;

create function public.svc_touch_receipt_job(p_job uuid) returns void
language sql security definer set search_path = '' as $$
  update public.receipt_jobs set checked_at = now() where id = p_job
$$;

-- Hook for per-receipt extras (line items, Phase 2). No-op in Phase 1.
create function public.svc_after_receipt_tx(p_household uuid, p_tx uuid, p_receipt jsonb, p_date date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  return;
end $$;

-- Turns parsed receipts into 'review' transactions. Idempotent per job.
-- p_results: [{client_id, ok, receipt:{merchant,date,total,category,note,items[]}} | {client_id, ok:false, reason}]
create function public.svc_complete_receipt_job(
  p_job uuid, p_results jsonb, p_input int, p_output int, p_usd numeric
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.receipt_jobs;
  r jsonb; it jsonb; v_items jsonb := '[]'::jsonb;
  v_parsed int := 0; v_failed int := 0;
  v_date date; v_amount numeric; v_person uuid; v_cat text; v_tx uuid;
begin
  select * into j from public.receipt_jobs where id = p_job for update;
  if not found or j.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;
  for it in select * from jsonb_array_elements(j.items) loop
    r := null;
    select e into r from jsonb_array_elements(p_results) e where e->>'client_id' = it->>'client_id' limit 1;
    v_person := nullif(it->>'person_id', '')::uuid;
    v_amount := null;
    if r is not null and coalesce((r->>'ok')::boolean, false) then
      begin
        v_amount := round((r #>> '{receipt,total}')::numeric, 2);
      exception when others then v_amount := null;
      end;
    end if;
    if v_amount is null or v_amount = 0 then
      v_failed := v_failed + 1;
      v_items := v_items || jsonb_build_array(it || jsonb_build_object('status',
                   case when r is null then 'failed' else coalesce(r->>'reason', 'unreadable') end));
      continue;
    end if;
    begin
      v_date := (r #>> '{receipt,date}')::date;
    exception when others then v_date := null;
    end;
    if v_date is null or v_date > (now() + interval '2 days')::date or v_date < (now() - interval '2 years')::date then
      v_date := (j.created_at at time zone 'Asia/Jerusalem')::date;
    end if;
    v_cat := left(coalesce(nullif(btrim(r #>> '{receipt,category}'), ''), 'שונות'), 40);
    insert into public.transactions (household_id, date, month, merchant, amount, category, is_fixed, note,
                                     person_id, source, source_title, status, receipt_job_id,
                                     receipt_client_id, created_by)
    values (j.household_id, v_date, to_char(v_date, 'YYYY-MM'),
            left(coalesce(nullif(btrim(r #>> '{receipt,merchant}'), ''), 'קבלה'), 120),
            v_amount, v_cat, false, left(coalesce(r #>> '{receipt,note}', ''), 200),
            v_person, 'receipt', 'קבלה', 'review', j.id, it->>'client_id', j.submitted_by)
    returning id into v_tx;
    perform public.svc_after_receipt_tx(j.household_id, v_tx, r->'receipt', v_date);
    v_parsed := v_parsed + 1;
    v_items := v_items || jsonb_build_array(it || jsonb_build_object('status', 'parsed', 'transaction_id', v_tx));
  end loop;
  update public.receipt_jobs
     set status = 'ended', ended_at = now(), checked_at = now(), items = v_items
   where id = j.id;
  if j.reservation_id is not null then
    perform public.svc_finalize_usage(j.reservation_id, v_parsed + v_failed, p_input, p_output, p_usd);
  end if;
  return jsonb_build_object('ok', true, 'household_id', j.household_id, 'submitted_by', j.submitted_by,
                            'parsed', v_parsed, 'failed', v_failed);
end $$;

create function public.svc_fail_receipt_job(p_job uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.receipt_jobs;
begin
  select * into j from public.receipt_jobs where id = p_job for update;
  if not found or j.status <> 'submitted' then
    return;
  end if;
  update public.receipt_jobs
     set status = 'failed', error = left(p_error, 200), ended_at = now(), checked_at = now(),
         items = (select coalesce(jsonb_agg(e || '{"status":"failed"}'::jsonb), '[]'::jsonb)
                    from jsonb_array_elements(j.items) e)
   where id = p_job;
  if j.reservation_id is not null then
    perform public.svc_release_usage(j.reservation_id);
  end if;
end $$;

create function public.svc_store_analysis(
  p_household uuid, p_user uuid, p_month text, p_data jsonb, p_model text
) returns void
language sql security definer set search_path = '' as $$
  insert into public.analyses (household_id, month, data, model, created_by)
  values (p_household, p_month, p_data, p_model, p_user)
  on conflict (household_id, month) do update
    set data = excluded.data, model = excluded.model, created_by = excluded.created_by, created_at = now()
$$;

-- Invite details for the join screen (before sign-in).
create function public.svc_invite_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.invites; v_name text;
begin
  select * into v from public.invites where token_hash = public.token_hash(p_token);
  if not found or v.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if v.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select name into v_name from public.households where id = v.household_id;
  return jsonb_build_object('ok', true, 'household_name', v_name, 'role', v.role, 'person_name', v.person_name);
end $$;

-- Binds an invite to the first e-mail that uses it (so a leaked link can't
-- be used to create more than one account).
create function public.svc_claim_invite(p_token text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites; v_email text := lower(btrim(p_email));
begin
  select * into v from public.invites where token_hash = public.token_hash(p_token) for update;
  if not found or v.revoked_at is not null or v.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if v.claimed_email is null then
    update public.invites set claimed_email = v_email where id = v.id;
  elsif v.claimed_email <> v_email then
    return jsonb_build_object('ok', false, 'reason', 'claimed');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Prepares account deletion: deletes households where the user is the only
-- member; refuses (and deletes nothing) if the user is the last owner of a
-- household that still has other members.
create function public.svc_prepare_account_deletion(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_blocked jsonb;
begin
  select coalesce(jsonb_agg(h.name), '[]'::jsonb) into v_blocked
    from public.household_members m
    join public.households h on h.id = m.household_id
   where m.user_id = p_user and m.role = 'owner'
     and not exists (select 1 from public.household_members o
                      where o.household_id = m.household_id and o.role = 'owner' and o.user_id <> p_user)
     and exists (select 1 from public.household_members o
                  where o.household_id = m.household_id and o.user_id <> p_user);
  if jsonb_array_length(v_blocked) > 0 then
    return jsonb_build_object('ok', false, 'blocked', v_blocked);
  end if;
  delete from public.households h
   where exists (select 1 from public.household_members m where m.household_id = h.id and m.user_id = p_user)
     and not exists (select 1 from public.household_members o where o.household_id = h.id and o.user_id <> p_user);
  update public.people set user_id = null where user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================== grants
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.is_member(uuid), public.can_write(uuid), public.is_owner(uuid), public.is_super_admin(),
  public.local_month(timestamptz),
  public.create_invite(uuid, public.member_role, text), public.revoke_invite(uuid),
  public.accept_invite(text, text), public.set_member_role(uuid, uuid, public.member_role),
  public.remove_member(uuid, uuid), public.delete_household(uuid), public.household_usage(uuid),
  public.admin_overview(text), public.admin_totals(text),
  public.admin_set_quotas(uuid, int, int, int, numeric), public.admin_set_global_cap(numeric),
  public.admin_create_household(text), public.admin_owner_invite(uuid), public.admin_delete_household(uuid)
to authenticated;

grant execute on all functions in schema public to service_role;
```

### supabase/migrations/0004_mfa.sql

```sql
-- ============================================================================
-- 0004_mfa.sql — two-factor authentication (TOTP) enforced in the database.
--
-- Rule (per household, per user):
--   aal2 is REQUIRED when the user
--     * is an owner of the household, or
--     * has any verified MFA factor (then every session must use it), or
--     * belongs to a household whose owner switched on require_mfa.
--   The super-admin always needs aal2 for admin functions.
-- Enforcement = RESTRICTIVE RLS policies (AND-ed with the existing ones) on all
-- household data, plus aal checks inside SECURITY DEFINER RPCs and Edge Functions.
-- ============================================================================

alter table public.household_settings add column require_mfa boolean not null default false;

-- 'aal1' | 'aal2' from the caller's JWT (PostgREST sets request.jwt.claims)
create function public.jwt_aal() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1')
$$;

create function public.has_verified_factor(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.mfa_factors f
    where f.user_id = p_user and f.status::text = 'verified' and f.factor_type::text <> 'recovery_code'
  )
$$;

create function public.mfa_required_for(p_household uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_verified_factor(p_user)
      or exists (select 1 from public.household_members m
                  where m.household_id = p_household and m.user_id = p_user and m.role = 'owner')
      or exists (select 1 from public.household_settings s
                  where s.household_id = p_household and s.require_mfa)
$$;

-- true when the current session may touch this household's data
create function public.mfa_ok(p_household uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2' or not public.mfa_required_for(p_household, (select auth.uid()))
$$;

-- Owners always need aal2, so is_owner() is only true at aal2. This one change
-- covers every owner-only policy and RPC defined in 0002/0003.
create or replace function public.is_owner(hh uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2' and exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = (select auth.uid()) and m.role = 'owner'
  )
$$;

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2'
     and exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
$$;

-- --------------------------------------------------- restrictive policies
create policy mfa_gate on public.people            as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate on public.transactions      as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate on public.fixed_expenses    as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate on public.shopping_items    as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate on public.analyses          as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate on public.receipt_jobs      as restrictive for all to authenticated
  using (public.mfa_ok(household_id));
create policy mfa_gate on public.usage_ledger      as restrictive for all to authenticated
  using (household_id is not null and public.mfa_ok(household_id));
create policy mfa_gate on public.invites           as restrictive for all to authenticated
  using (public.mfa_ok(household_id));
-- household list, roster and settings stay READABLE at aal1 so the app can tell
-- the user that a code is needed; changing them needs the gate.
create policy mfa_gate_update on public.household_settings as restrictive for update to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy mfa_gate_update on public.households as restrictive for update to authenticated
  using (public.mfa_ok(id)) with check (public.mfa_ok(id));

-- ------------------------------------------------------ owner switch
create function public.set_require_mfa(p_household uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  update public.household_settings set require_mfa = p_on where household_id = p_household;
end $$;

-- household_usage() must respect the gate too
create or replace function public.household_usage(p_household uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; s public.household_settings; v_month text := public.local_month();
begin
  if not public.is_member(p_household) or not public.mfa_ok(p_household) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  select * into s from public.household_settings where household_id = p_household;
  select jsonb_build_object(
    'month', v_month,
    'images', coalesce(sum(units) filter (where kind = 'receipt'), 0),
    'statements', coalesce(sum(units) filter (where kind = 'statement'), 0),
    'analyses', coalesce(sum(units) filter (where kind = 'analysis'), 0),
    'usd', round(coalesce(sum(usd), 0), 4),
    'quota_images', s.quota_images, 'quota_statements', s.quota_statements,
    'quota_analyses', s.quota_analyses, 'quota_usd', s.quota_usd)
  into v
  from public.usage_ledger
  where household_id = p_household and month = v_month and status <> 'released';
  return v;
end $$;

-- ------------------------------------------------------ recovery codes
-- 10 single-use codes per user, stored as sha256(user_id:CODE). The plaintext
-- is returned once, right after the user verified their authenticator (aal2).
create table public.mfa_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz null,
  created_at  timestamptz not null default now()
);
create index mfa_recovery_codes_user_idx on public.mfa_recovery_codes (user_id);
alter table public.mfa_recovery_codes enable row level security;   -- no policies: RPCs only

create function public.recovery_code_hash(p_user uuid, p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_user::text || ':' ||
         upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'UTF8')), 'hex')
$$;

create function public.generate_recovery_codes() returns text[]
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_codes text[] := '{}'; v_code text; i int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if public.jwt_aal() <> 'aal2' then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
  delete from public.mfa_recovery_codes where user_id = v_uid;
  for i in 1..10 loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    insert into public.mfa_recovery_codes (user_id, code_hash) values (v_uid, public.recovery_code_hash(v_uid, v_code));
    v_codes := v_codes || (substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5));
  end loop;
  return v_codes;
end $$;

create function public.recovery_codes_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('total', count(*), 'remaining', count(*) filter (where used_at is null))
    from public.mfa_recovery_codes where user_id = (select auth.uid())
$$;

-- ------------------------------------------------------ service helpers
-- One call for Edge Functions: role + whether this session passes the MFA rule.
create function public.svc_access(p_household uuid, p_user uuid, p_aal text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', (select role::text from public.household_members where household_id = p_household and user_id = p_user),
    'mfa_required', public.mfa_required_for(p_household, p_user),
    'mfa_ok', coalesce(p_aal, 'aal1') = 'aal2' or not public.mfa_required_for(p_household, p_user))
$$;

create function public.svc_use_recovery_code(p_user uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.mfa_recovery_codes
   where user_id = p_user and used_at is null and code_hash = public.recovery_code_hash(p_user, p_code)
   limit 1 for update;
  if v_id is null then
    return false;
  end if;
  update public.mfa_recovery_codes set used_at = now() where id = v_id;
  return true;
end $$;

create function public.svc_clear_recovery_codes(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.mfa_recovery_codes where user_id = p_user
$$;

-- May p_caller (an owner at aal2 — checked by the Edge Function from the JWT)
-- reset p_target's MFA? Only for members/viewers of the same household.
create function public.svc_can_reset_mfa(p_household uuid, p_caller uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_caller <> p_target
     and exists (select 1 from public.household_members where household_id = p_household and user_id = p_caller and role = 'owner')
     and exists (select 1 from public.household_members where household_id = p_household and user_id = p_target and role <> 'owner')
     and not exists (select 1 from public.app_admins where user_id = p_target)
$$;

-- ------------------------------------------------------------------ grants
revoke all on public.mfa_recovery_codes from anon, authenticated;
revoke execute on function
  public.jwt_aal(), public.has_verified_factor(uuid), public.mfa_required_for(uuid, uuid),
  public.mfa_ok(uuid), public.set_require_mfa(uuid, boolean), public.recovery_code_hash(uuid, text),
  public.generate_recovery_codes(), public.recovery_codes_status(), public.svc_access(uuid, uuid, text),
  public.svc_use_recovery_code(uuid, text), public.svc_clear_recovery_codes(uuid),
  public.svc_can_reset_mfa(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.jwt_aal(), public.mfa_ok(uuid), public.set_require_mfa(uuid, boolean),
  public.generate_recovery_codes(), public.recovery_codes_status()
to authenticated;
grant execute on all functions in schema public to service_role;
```

### supabase/migrations/0005_app.sql

```sql
-- ============================================================================
-- 0005_app.sql — small helpers the app needs.
-- ============================================================================

-- Lets the app know whether to show the admin entry (and to ask for 2FA first).
-- Says nothing about anyone else; admin DATA still requires aal2 (is_super_admin()).
create function public.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
$$;
revoke execute on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;
```

### supabase/migrations/0006_phase2.sql

```sql
-- ============================================================================
-- 0006_phase2.sql — budgets (+80/100% alerts), Web Push, receipt line items
-- (price history), annual expenses calendar, savings goals, fixed-expense
-- suggestion dismissals. Same model as Phase 1: RLS default deny, members read,
-- owners/members write, restrictive aal2 gate on household data.
-- ============================================================================

-- ---------------------------------------------------------------- budgets
create table public.budgets (
  household_id  uuid not null references public.households (id) on delete cascade,
  category      text not null check (char_length(category) between 1 and 40),
  amount        numeric(12,2) not null check (amount > 0),
  updated_at    timestamptz not null default now(),
  primary key (household_id, category)
);

-- one row per (category, month, level) that fired — dedupes the push alert
create table public.budget_alerts (
  household_id  uuid not null references public.households (id) on delete cascade,
  category      text not null,
  month         text not null,
  level         smallint not null check (level in (80, 100)),
  created_at    timestamptz not null default now(),
  primary key (household_id, category, month, level)
);

-- ------------------------------------------------------ price history
create table public.receipt_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  transaction_id  uuid not null,
  name            text not null check (char_length(name) between 1 and 80),
  norm_name       text not null check (char_length(norm_name) <= 80),
  qty             numeric(10,3) not null default 1,
  unit_price      numeric(12,2) null,
  total           numeric(12,2) null,
  store           text not null default '' check (char_length(store) <= 80),
  date            date not null,
  created_at      timestamptz not null default now(),
  foreign key (household_id, transaction_id) references public.transactions (household_id, id) on delete cascade
);
create index receipt_items_name_idx on public.receipt_items (household_id, norm_name);

-- ------------------------------------------------- annual expenses
create table public.annual_expenses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  amount        numeric(12,2) not null check (amount >= 0),
  due_month     smallint not null check (due_month between 1 and 12),
  due_day       smallint not null default 1 check (due_day between 1 and 31),
  category      text not null default 'שונות' check (char_length(category) between 1 and 40),
  person_id     uuid null,
  remind_days   smallint not null default 14 check (remind_days between 0 and 90),
  note          text not null default '' check (char_length(note) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (household_id, person_id) references public.people (household_id, id) on delete set null (person_id)
);

-- --------------------------------------------------- savings goals
create table public.savings_goals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  target        numeric(12,2) not null check (target > 0),
  target_date   date null,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, id)
);

create table public.goal_deposits (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  goal_id       uuid not null,
  amount        numeric(12,2) not null check (amount <> 0),
  date          date not null default current_date,
  note          text not null default '' check (char_length(note) <= 100),
  created_by    uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (household_id, goal_id) references public.savings_goals (household_id, id) on delete cascade
);

-- ------------------------------------- fixed-expense suggestions
create table public.suggestion_dismissals (
  household_id  uuid not null references public.households (id) on delete cascade,
  key           text not null check (char_length(key) <= 120),
  created_at    timestamptz not null default now(),
  primary key (household_id, key)
);

-- ------------------------------------------------------ notifications
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) between 20 and 200),
  auth        text not null check (char_length(auth) between 8 and 100),
  user_agent  text not null default '' check (char_length(user_agent) <= 200),
  fail_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz null
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.notification_prefs (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  weekly_summary  boolean not null default true,
  bills           boolean not null default true,
  receipts        boolean not null default true,
  budget          boolean not null default true,
  weekly_day      smallint not null default 0 check (weekly_day between 0 and 6),
  quiet_start     smallint not null default 22 check (quiet_start between 0 and 23),
  quiet_end       smallint not null default 7 check (quiet_end between 0 and 23),
  tz              text not null default 'Asia/Jerusalem' check (char_length(tz) <= 60),
  updated_at      timestamptz not null default now()
);

create table public.notification_queue (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  household_id  uuid null references public.households (id) on delete cascade,
  kind          text not null check (kind in ('receipts', 'budget', 'bill', 'annual', 'weekly', 'test')),
  title         text not null check (char_length(title) <= 80),
  body          text not null check (char_length(body) <= 240),
  url           text not null default './#/overview' check (char_length(url) <= 200),
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz null,
  unique (user_id, kind, dedupe_key)
);
create index notification_queue_unsent_idx on public.notification_queue (created_at) where sent_at is null;

-- ------------------------------------------------------------ triggers
create trigger annual_touch before update on public.annual_expenses
  for each row execute function public.touch_updated_at();
create trigger goals_touch before update on public.savings_goals
  for each row execute function public.touch_updated_at();

-- prefs of a user, with defaults when they never saved any
create function public.prefs_of(p_user uuid) returns public.notification_prefs
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p from public.notification_prefs p where p.user_id = p_user),
    row(p_user, true, true, true, true, 0::smallint, 22::smallint, 7::smallint, 'Asia/Jerusalem', now())::public.notification_prefs)
$$;

-- enqueue one notification for every member of a household who wants this kind
create function public.enqueue_household(
  p_household uuid, p_kind text, p_title text, p_body text, p_url text, p_key text, p_writers_only boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare m record; pr public.notification_prefs;
begin
  for m in select user_id, role from public.household_members where household_id = p_household loop
    if p_writers_only and m.role = 'viewer' then continue; end if;
    pr := public.prefs_of(m.user_id);
    if (p_kind = 'budget' and not pr.budget) or (p_kind = 'receipts' and not pr.receipts)
       or (p_kind in ('bill', 'annual') and not pr.bills) or (p_kind = 'weekly' and not pr.weekly_summary) then
      continue;
    end if;
    insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
    values (m.user_id, p_household, p_kind, left(p_title, 80), left(p_body, 240), p_url, p_key)
    on conflict (user_id, kind, dedupe_key) do nothing;
  end loop;
end $$;

-- Budget alerts at 80% and 100% (once per category / month / level).
create function public.budget_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b numeric; spent numeric; lvl smallint; inserted int;
begin
  if new.status <> 'saved' then return new; end if;
  select amount into b from public.budgets where household_id = new.household_id and category = new.category;
  if b is null then return new; end if;
  select coalesce(sum(amount), 0) into spent from public.transactions
   where household_id = new.household_id and month = new.month and category = new.category and status = 'saved';
  lvl := case when spent >= b then 100 when spent >= b * 0.8 then 80 else null end;
  if lvl is null then return new; end if;
  insert into public.budget_alerts (household_id, category, month, level) values (new.household_id, new.category, new.month, lvl)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    perform public.enqueue_household(new.household_id, 'budget',
      case when lvl = 100 then 'עברתם את התקציב' else 'קרוב לתקציב' end,
      new.category || ': ' || round(spent)::text || ' ₪ מתוך ' || round(b)::text || ' ₪ (' || round(spent / b * 100)::text || '%)',
      './#/plan', new.category || ':' || new.month || ':' || lvl);
  end if;
  return new;
end $$;
create trigger transactions_budget after insert or update of amount, category, month, status on public.transactions
  for each row execute function public.budget_check();

-- "X receipts ready for approval" when a batch finishes.
create function public.receipts_ready() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if old.status = 'submitted' and new.status = 'ended' then
    select count(*) into n from jsonb_array_elements(new.items) e where e->>'status' = 'parsed';
    if n > 0 then
      perform public.enqueue_household(new.household_id, 'receipts',
        case when n = 1 then 'קבלה אחת מחכה לאישור' else n::text || ' קבלות מחכות לאישור' end,
        'Claude קרא את הקבלות. אפשר לבדוק ולאשר.', './#/tx', new.id::text, true);
    end if;
  end if;
  return new;
end $$;
create trigger receipt_jobs_ready after update of status on public.receipt_jobs
  for each row execute function public.receipts_ready();

-- Receipt line items → price history (replaces the Phase 1 no-op hook).
create or replace function public.svc_after_receipt_tx(p_household uuid, p_tx uuid, p_receipt jsonb, p_date date)
returns void language plpgsql security definer set search_path = '' as $$
declare it jsonb; v_name text; v_store text := left(coalesce(p_receipt->>'merchant', ''), 80);
begin
  for it in select * from jsonb_array_elements(coalesce(p_receipt->'items', '[]'::jsonb)) limit 120 loop
    v_name := left(btrim(coalesce(it->>'name', '')), 80);
    if v_name = '' then continue; end if;
    begin
      insert into public.receipt_items (household_id, transaction_id, name, norm_name, qty, unit_price, total, store, date)
      values (p_household, p_tx, v_name, public.norm_item(v_name),
              coalesce(nullif(it->>'qty', '')::numeric, 1), nullif(it->>'unit_price', '')::numeric,
              nullif(it->>'total', '')::numeric, v_store, p_date);
    exception when others then null; -- a malformed line never blocks the receipt itself
    end;
  end loop;
end $$;

create function public.norm_item(p text) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(lower(regexp_replace(coalesce(p, ''), '["''׳״.,()*/\\-]', ' ', 'g')), '\s+', ' ', 'g')), 80)
$$;

-- ------------------------------------------------ scheduled notifications
-- Adds weekly summaries and bill/annual reminders that are due, then returns
-- unsent notifications for users who are not in their quiet hours, joined
-- with their push subscriptions. Called by the notify Edge Function (cron).
create function public.svc_due_notifications(p_now timestamptz default now())
returns table (queue_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, title text, body text, url text, tag text)
language plpgsql security definer set search_path = '' as $$
declare
  m record; pr public.notification_prefs; loc timestamp; wk numeric; mo numeric; f record; a record;
  due date; today date;
begin
  for m in select distinct hm.user_id, hm.household_id from public.household_members hm
           where exists (select 1 from public.push_subscriptions s where s.user_id = hm.user_id) loop
    pr := public.prefs_of(m.user_id);
    loc := p_now at time zone pr.tz;
    today := loc::date;
    -- weekly summary on the chosen day, from 09:00
    if pr.weekly_summary and extract(dow from loc) = pr.weekly_day and extract(hour from loc) >= 9 then
      select coalesce(sum(amount), 0) into wk from public.transactions
       where household_id = m.household_id and status = 'saved' and date > today - 7 and date <= today
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות');
      select coalesce(sum(amount), 0) into mo from public.transactions
       where household_id = m.household_id and status = 'saved' and month = to_char(loc, 'YYYY-MM')
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות');
      insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
      values (m.user_id, m.household_id, 'weekly', 'סיכום שבועי',
              'השבוע יצאו ' || round(wk)::text || ' ₪. מתחילת החודש: ' || round(mo)::text || ' ₪.', './#/overview',
              to_char(loc, 'IYYY-IW') || ':' || m.household_id)
      on conflict do nothing;
    end if;
    if pr.bills then
      -- monthly fixed expenses with a due day, 3 days ahead
      for f in select id, name, amount, due_day from public.fixed_expenses
               where household_id = m.household_id and due_day is not null and cycle = 1 loop
        due := make_date(extract(year from today)::int, extract(month from today)::int,
                         least(f.due_day, extract(day from (date_trunc('month', today) + interval '1 month - 1 day'))::int));
        if due < today then
          due := (date_trunc('month', today) + interval '1 month')::date + (least(f.due_day, 28) - 1);
        end if;
        if due - today between 0 and 3 then
          insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
          values (m.user_id, m.household_id, 'bill', 'חיוב קרוב: ' || left(f.name, 50),
                  'בעוד ' || (due - today)::text || ' ימים, בערך ' || round(f.amount)::text || ' ₪.', './#/fixed',
                  f.id::text || ':' || to_char(due, 'YYYY-MM'))
          on conflict do nothing;
        end if;
      end loop;
      -- annual expenses, remind_days ahead
      for a in select id, name, amount, due_month, due_day, remind_days from public.annual_expenses
               where household_id = m.household_id loop
        due := make_date(extract(year from today)::int, a.due_month, least(a.due_day, 28));
        if due < today then due := make_date(extract(year from today)::int + 1, a.due_month, least(a.due_day, 28)); end if;
        if due - today between 0 and a.remind_days then
          insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
          values (m.user_id, m.household_id, 'annual', 'הוצאה שנתית מתקרבת: ' || left(a.name, 40),
                  to_char(due, 'DD/MM') || ' · בערך ' || round(a.amount)::text || ' ₪.', './#/plan',
                  a.id::text || ':' || extract(year from due)::text)
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;

  -- stale notifications are dropped, not sent late
  update public.notification_queue set sent_at = p_now where sent_at is null and created_at < p_now - interval '3 days';

  return query
  select q.id, s.id, s.endpoint, s.p256dh, s.auth, q.title, q.body, q.url, q.kind || ':' || left(q.dedupe_key, 40)
    from public.notification_queue q
    join public.push_subscriptions s on s.user_id = q.user_id
   where q.sent_at is null
     and not (
       case when (public.prefs_of(q.user_id)).quiet_start > (public.prefs_of(q.user_id)).quiet_end
            then extract(hour from p_now at time zone (public.prefs_of(q.user_id)).tz) >= (public.prefs_of(q.user_id)).quiet_start
              or extract(hour from p_now at time zone (public.prefs_of(q.user_id)).tz) < (public.prefs_of(q.user_id)).quiet_end
            else extract(hour from p_now at time zone (public.prefs_of(q.user_id)).tz) >= (public.prefs_of(q.user_id)).quiet_start
             and extract(hour from p_now at time zone (public.prefs_of(q.user_id)).tz) < (public.prefs_of(q.user_id)).quiet_end
       end)
   order by q.created_at
   limit 300;
end $$;

create function public.svc_mark_sent(p_queue uuid[], p_ok_subs uuid[], p_dead_subs uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_queue set sent_at = now() where id = any (p_queue);
  update public.push_subscriptions set last_ok_at = now(), fail_count = 0 where id = any (p_ok_subs);
  delete from public.push_subscriptions where id = any (p_dead_subs);
end $$;

create function public.svc_user_subscriptions(p_user uuid)
returns table (subscription_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = '' as $$
  select id, endpoint, p256dh, auth from public.push_subscriptions where user_id = p_user
$$;

-- ------------------------------------------------------------------- RLS
alter table public.budgets               enable row level security;
alter table public.budget_alerts         enable row level security;
alter table public.receipt_items         enable row level security;
alter table public.annual_expenses       enable row level security;
alter table public.savings_goals         enable row level security;
alter table public.goal_deposits         enable row level security;
alter table public.suggestion_dismissals enable row level security;
alter table public.push_subscriptions    enable row level security;
alter table public.notification_prefs    enable row level security;
alter table public.notification_queue    enable row level security;   -- no policies: service only

-- household tables: members read, owners/members write, aal2 gate
do $$
declare t text;
begin
  foreach t in array array['budgets', 'annual_expenses', 'savings_goals', 'goal_deposits', 'suggestion_dismissals', 'receipt_items', 'budget_alerts'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.is_member(household_id))', t);
    execute format('create policy mfa_gate on public.%1$s as restrictive for all to authenticated using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id))', t);
  end loop;
  foreach t in array array['budgets', 'annual_expenses', 'savings_goals', 'suggestion_dismissals'] loop
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_write(household_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_write(household_id)) with check (public.can_write(household_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.can_write(household_id))', t);
  end loop;
end $$;
create policy goal_deposits_insert on public.goal_deposits for insert to authenticated
  with check (public.can_write(household_id) and created_by = (select auth.uid()));
create policy goal_deposits_delete on public.goal_deposits for delete to authenticated using (public.can_write(household_id));
create policy receipt_items_delete on public.receipt_items for delete to authenticated using (public.can_write(household_id));

-- personal tables: only your own rows. A push subscription carries amounts in
-- notifications, so creating one needs the second factor when you have one.
create policy push_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create function public.personal_mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2' or not public.has_verified_factor((select auth.uid()))
$$;
create policy push_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and public.personal_mfa_ok());
create policy push_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
create policy prefs_select on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));
create policy prefs_insert on public.notification_prefs for insert to authenticated with check (user_id = (select auth.uid()));
create policy prefs_update on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- grants
revoke all on public.budgets, public.budget_alerts, public.receipt_items, public.annual_expenses, public.savings_goals,
  public.goal_deposits, public.suggestion_dismissals, public.push_subscriptions, public.notification_prefs,
  public.notification_queue from anon, authenticated;
grant select, insert, update, delete on public.budgets, public.annual_expenses, public.savings_goals, public.suggestion_dismissals to authenticated;
grant select on public.budget_alerts to authenticated;
grant select, delete on public.receipt_items to authenticated;
grant select, insert, delete on public.goal_deposits to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant select, insert, update on public.notification_prefs to authenticated;
grant all on all tables in schema public to service_role;
revoke execute on function public.personal_mfa_ok() from public, anon;
grant execute on function public.personal_mfa_ok() to authenticated;

revoke execute on function public.prefs_of(uuid), public.enqueue_household(uuid, text, text, text, text, text, boolean),
  public.budget_check(), public.receipts_ready(), public.norm_item(text), public.svc_due_notifications(timestamptz),
  public.svc_mark_sent(uuid[], uuid[], uuid[]), public.svc_user_subscriptions(uuid)
from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
```
