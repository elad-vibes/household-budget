-- ============================================================================
-- 0010_price_compare.sql — "איפה הכי זול?" (next-features.md §1, SuperMCP).
--   * household_settings.price_city / price_street: the ONLY location data sent to
--     SuperMCP (no names, e-mails or household ids). Members/owners may set them.
--   * price_compare_cache: the trimmed result per household + list hash, 6h; server only.
--   * svc_price_compare_input: the open shopping-list items + location for the function.
-- Read-only feature: nothing here writes transactions or money data.
-- ============================================================================

alter table public.household_settings
  add column price_city   text null check (char_length(btrim(price_city)) between 2 and 60),
  add column price_street text null check (char_length(btrim(price_street)) between 2 and 80);
grant update (price_city, price_street) on public.household_settings to authenticated;

create table public.price_compare_cache (
  household_id  uuid not null references public.households (id) on delete cascade,
  list_hash     text not null check (list_hash ~ '^[0-9a-f]{64}$'),
  result        jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (household_id, list_hash)
);
alter table public.price_compare_cache enable row level security;   -- no policies: service role only
revoke all on public.price_compare_cache from anon, authenticated;
grant all on public.price_compare_cache to service_role;

-- Open items (max 50, list order) + the comparison location of a household.
create function public.svc_price_compare_input(p_household uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty) order by i.sort, i.created_at)
                         from (select name, qty, sort, created_at from public.shopping_items
                                where household_id = p_household and not done
                                order by sort, created_at limit 50) i), '[]'::jsonb),
    'city', s.price_city, 'street', s.price_street)
  from public.household_settings s where s.household_id = p_household
$$;

create function public.svc_price_cache_get(p_household uuid, p_hash text, p_max_age_secs int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select result from public.price_compare_cache
   where household_id = p_household and list_hash = p_hash
     and created_at > now() - make_interval(secs => p_max_age_secs)
$$;

create function public.svc_price_cache_put(p_household uuid, p_hash text, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.price_compare_cache where household_id = p_household and created_at < now() - interval '1 day';
  insert into public.price_compare_cache (household_id, list_hash, result) values (p_household, p_hash, p_result)
  on conflict (household_id, list_hash) do update set result = excluded.result, created_at = now();
end $$;

revoke execute on function public.svc_price_compare_input(uuid), public.svc_price_cache_get(uuid, text, int),
  public.svc_price_cache_put(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.svc_price_compare_input(uuid), public.svc_price_cache_get(uuid, text, int),
  public.svc_price_cache_put(uuid, text, jsonb) to service_role;
