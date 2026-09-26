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

## Appendix — full schema SQL (`supabase/migrations/`)

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
