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
