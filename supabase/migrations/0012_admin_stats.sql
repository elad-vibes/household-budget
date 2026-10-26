-- 0012: private admin dashboard (Elad only) — general numbers, never family data.
--
-- `stats_snapshot()` returns ONE jsonb of counts, AI cost vs quota, receipt /
-- statement outcomes and pg_cron health. It never returns purchase amounts,
-- merchants, items, household names, people or e-mails: households appear only
-- as an ordinal ("1", "2", … by creation date).
--
-- It is executable ONLY by the dedicated role `hb_stats`, which has no table
-- privileges at all. The collector on Elad's server signs in as that role, so a
-- leaked collector password exposes these aggregates and nothing else.
-- The role is created NOLOGIN here; `node scripts/stats/role.mjs` gives it a
-- password on the live project (the password lives only in .env.local / the server).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hb_stats') then
    create role hb_stats nologin noinherit;
  end if;
end $$;

-- lets the owner `set role hb_stats` in tests (also on the live DB); harmless:
-- hb_stats has fewer privileges than its owner
do $$
begin
  execute format('grant hb_stats to %I', current_user);
exception when others then null;
end $$;

grant usage on schema public to hb_stats;

create function public.stats_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_month  text := public.local_month();
  v_months text[];
  v_cron   jsonb := null;
  v        jsonb;
begin
  select array_agg(public.local_month(now() - make_interval(months => i)) order by i desc)
    into v_months from generate_series(0, 5) i;

  -- pg_cron exists only on Supabase (not in the PGlite test DB)
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'job', j.jobname, 'schedule', j.schedule, 'active', j.active,
               'last_run_at', r.last_start, 'last_status', r.last_status,
               'runs_24h', coalesce(r.runs_24h, 0), 'failed_24h', coalesce(r.failed_24h, 0))
             order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (
        select max(d.start_time) as last_start,
               (array_agg(d.status order by d.start_time desc))[1] as last_status,
               count(*) filter (where d.start_time > now() - interval '24 hours') as runs_24h,
               count(*) filter (where d.start_time > now() - interval '24 hours' and d.status = 'failed') as failed_24h
        from cron.job_run_details d
        where d.jobid = j.jobid and d.start_time > now() - interval '7 days'
      ) r on true
      where j.jobname like 'hb-%'
    $q$ into v_cron;
  end if;

  with
  hh as (
    select h.id, row_number() over (order by h.created_at, h.id) as n
    from public.households h
  ),
  seen as (   -- last sign of life per user: sign-in, session refresh, or a row they added
    select u.id as user_id,
           greatest(u.last_sign_in_at,
                    (select max(coalesce(s.refreshed_at, s.updated_at)) from auth.sessions s where s.user_id = u.id),
                    (select max(t.created_at) from public.transactions t where t.created_by = u.id)) as at
    from auth.users u
    where exists (select 1 from public.household_members m where m.user_id = u.id)
  ),
  usage_month as (
    select household_id,
           coalesce(sum(usd), 0) as usd,
           coalesce(sum(units) filter (where kind = 'receipt'), 0) as images,
           coalesce(sum(units) filter (where kind = 'statement'), 0) as statements,
           coalesce(sum(units) filter (where kind = 'analysis'), 0) as analyses
    from public.usage_ledger
    where month = v_month and status <> 'released'
    group by household_id
  ),
  receipt_items as (
    select i ->> 'status' as status
    from public.receipt_jobs j, jsonb_array_elements(j.items) i
    where public.local_month(j.created_at) = v_month
  )
  select jsonb_build_object(
    'month', v_month,
    'generated_at', now(),
    'households', jsonb_build_object(
      'total', (select count(*) from hh),
      'active_30d', (select count(distinct m.household_id) from public.household_members m
                     join seen on seen.user_id = m.user_id where seen.at > now() - interval '30 days')),
    'users', jsonb_build_object(
      'total', (select count(*) from seen),
      'active_7d', (select count(*) from seen where at > now() - interval '7 days'),
      'active_30d', (select count(*) from seen where at > now() - interval '30 days')),
    'ai', jsonb_build_object(
      'month_usd', (select round(coalesce(sum(usd), 0), 4) from usage_month),
      'cap_usd', (select (value #>> '{}')::numeric from public.app_config where key = 'global_usd_cap'),
      'by_household', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'n', hh.n, 'usd', round(coalesce(u.usd, 0), 4), 'quota_usd', s.quota_usd,
                 'images', coalesce(u.images, 0), 'quota_images', s.quota_images,
                 'statements', coalesce(u.statements, 0), 'quota_statements', s.quota_statements,
                 'analyses', coalesce(u.analyses, 0), 'quota_analyses', s.quota_analyses)
               order by hh.n), '[]'::jsonb)
        from hh
        join public.household_settings s on s.household_id = hh.id
        left join usage_month u on u.household_id = hh.id),
      'last_months', (
        select jsonb_agg(jsonb_build_object('month', m,
                 'usd', (select round(coalesce(sum(usd), 0), 4) from public.usage_ledger
                         where month = m and status <> 'released')) order by m)
        from unnest(v_months) m)),
    'receipts', jsonb_build_object(
      'parsed', (select count(*) from receipt_items where status = 'parsed'),
      'unreadable', (select count(*) from receipt_items where status = 'unreadable'),
      'failed', (select count(*) from receipt_items where status = 'failed'),
      'waiting', (select count(*) from receipt_items where status = 'submitted'),
      'open_batches', (select count(*) from public.receipt_jobs where status = 'submitted'),
      'oldest_open_at', (select min(created_at) from public.receipt_jobs where status = 'submitted'),
      'last_checked_at', (select max(checked_at) from public.receipt_jobs)),
    'statements', jsonb_build_object(
      'ok', (select count(*) from public.usage_ledger where kind = 'statement' and month = v_month and status = 'final'),
      'failed', (select count(*) from public.usage_ledger where kind = 'statement' and month = v_month and status = 'released')),
    'analyses', jsonb_build_object(
      'ok', (select count(*) from public.usage_ledger where kind = 'analysis' and month = v_month and status = 'final'),
      'failed', (select count(*) from public.usage_ledger where kind = 'analysis' and month = v_month and status = 'released')),
    'cron', v_cron)
  into v;
  return v;
end $$;

revoke all on function public.stats_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.stats_snapshot() to hb_stats;
