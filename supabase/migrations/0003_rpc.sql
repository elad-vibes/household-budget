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
