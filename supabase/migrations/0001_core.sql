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
