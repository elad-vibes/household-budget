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
