-- ============================================================================
-- 0007_single_owner.sql — exactly one owner ("מנהל/ת") per household
-- (household-roles.md, Elad 2026-09-27).
--   * a partial unique index makes a second owner impossible
--   * invites from inside a household create only member/viewer; the only owner
--     invites are the super-admin's, for households with no members yet
--   * set_member_role never promotes to owner → transfer_ownership() swaps the
--     two roles in one transaction (owner at aal2 only, via is_owner())
--   * leaving / deleting the account while other members exist still needs a
--     transfer first (remove_member / svc_prepare_account_deletion: last_owner)
-- MFA rules are unchanged (owner + super-admin always aal2).
-- ============================================================================

create unique index household_one_owner on public.household_members (household_id) where role = 'owner';

create or replace function public.create_invite(
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
  if p_role = 'owner' then
    raise exception 'owner_invite' using errcode = 'P0001';
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

create or replace function public.accept_invite(p_token text, p_display_name text default null) returns uuid
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
  -- an owner invite (super-admin, empty household) is void once the household has its owner
  if v_inv.role = 'owner' and exists (select 1 from public.household_members
                                       where household_id = v_inv.household_id and role = 'owner') then
    raise exception 'household_has_owner' using errcode = 'P0001';
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

-- member <-> viewer only. The owner's own role changes only through a transfer.
create or replace function public.set_member_role(p_household uuid, p_user uuid, p_role public.member_role) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cur public.member_role;
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'use_transfer' using errcode = 'P0001';
  end if;
  select role into v_cur from public.household_members where household_id = p_household and user_id = p_user for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_cur = 'owner' then
    raise exception 'last_owner' using errcode = 'P0001';
  end if;
  update public.household_members set role = p_role where household_id = p_household and user_id = p_user;
end $$;

-- The owner hands the household to another member/viewer: caller becomes a
-- member, target becomes the owner. Demote first, then promote (the unique
-- index allows one owner at any moment). The new owner is asked to set up
-- two-factor on their next open (owners always need aal2).
create function public.transfer_ownership(p_household uuid, p_new_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.member_role;
begin
  if not public.is_owner(p_household) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if p_new_owner is null or p_new_owner = auth.uid() then
    raise exception 'invalid' using errcode = '22023';
  end if;
  select role into v_role from public.household_members
   where household_id = p_household and user_id = p_new_owner for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.household_members where household_id = p_household and user_id = auth.uid() for update;
  update public.household_members set role = 'member' where household_id = p_household and user_id = auth.uid();
  update public.household_members set role = 'owner' where household_id = p_household and user_id = p_new_owner;
end $$;

revoke execute on function public.transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated, service_role;
