-- ============================================================================
-- 0015_trip_mode.sql — "מצב טיול" / foreign currency (next-features.md §5).
--   * transactions keep the original: original_amount + original_currency + fx_rate
--     (all three or none). amount stays the household's ₪ amount = round(original × rate, 2).
--   * household_settings.trip_mode + trip_currency: the default currency for manual / quick add.
--   * fx_rates: one shared cache of official daily rates (₪ per 1 unit) — Bank of Israel
--     representative rates first, the ECB reference rates (crossed through EUR→ILS) for
--     currencies the Bank of Israel doesn't publish (THB among them). Public data, written
--     only by the fx-rates Edge Function (service role). fx_meta = when we last fetched.
--   * fx_overrides: a household's manual rate per currency (wins over the official one).
--   * receipts (svc_complete_receipt_job), the iPhone capture (svc_capture) and the statement
--     import (apply_statement) now keep foreign amounts; a statement merge stores the card's
--     actual rate on the logged row.
-- ============================================================================

-- ------------------------------------------------------------ transactions
alter table public.transactions
  add column original_amount   numeric(12,2) null check (original_amount <> 0 and abs(original_amount) <= 100000000),
  add column original_currency text null check (original_currency ~ '^[A-Z]{3}$' and original_currency <> 'ILS'),
  add column fx_rate           numeric(14,6) null check (fx_rate > 0 and fx_rate < 100000),
  add constraint transactions_fx_together check (
    (original_amount is null) = (original_currency is null) and (original_currency is null) = (fx_rate is null));
grant update (original_amount, original_currency, fx_rate) on public.transactions to authenticated;

-- ------------------------------------------------------------ settings
alter table public.household_settings
  add column trip_mode     boolean not null default false,
  add column trip_currency text not null default 'THB' check (trip_currency ~ '^[A-Z]{3}$' and trip_currency <> 'ILS');
grant update (trip_mode, trip_currency) on public.household_settings to authenticated;

-- ------------------------------------------------------------ official rates (shared cache)
create table public.fx_rates (
  rate_date     date not null,
  currency      text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'ILS'),
  ils_per_unit  numeric(14,6) not null check (ils_per_unit > 0),
  source        text not null check (source in ('boi', 'ecb')),
  fetched_at    timestamptz not null default now(),
  primary key (currency, rate_date)
);
create table public.fx_meta (
  id            boolean primary key default true check (id),
  last_attempt  timestamptz null,
  last_success  timestamptz null
);
insert into public.fx_meta (id) values (true);
alter table public.fx_rates enable row level security;   -- no policies: service role only
alter table public.fx_meta enable row level security;
revoke all on public.fx_rates, public.fx_meta from anon, authenticated;
grant all on public.fx_rates, public.fx_meta to service_role;

-- ------------------------------------------------------------ manual rate per household
create table public.fx_overrides (
  household_id  uuid not null references public.households (id) on delete cascade,
  currency      text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'ILS'),
  ils_per_unit  numeric(14,6) not null check (ils_per_unit > 0 and ils_per_unit < 100000),
  updated_by    uuid null default auth.uid() references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (household_id, currency)
);
alter table public.fx_overrides enable row level security;
create policy fx_overrides_select on public.fx_overrides for select to authenticated using (public.is_member(household_id));
create policy fx_overrides_insert on public.fx_overrides for insert to authenticated with check (public.can_write(household_id));
create policy fx_overrides_update on public.fx_overrides for update to authenticated
  using (public.can_write(household_id)) with check (public.can_write(household_id));
create policy fx_overrides_delete on public.fx_overrides for delete to authenticated using (public.can_write(household_id));
create policy mfa_gate on public.fx_overrides as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
revoke all on public.fx_overrides from anon, authenticated;
grant select, insert (household_id, currency, ils_per_unit), delete on public.fx_overrides to authenticated;
grant update (ils_per_unit, updated_at) on public.fx_overrides to authenticated;
grant all on public.fx_overrides to service_role;

-- ------------------------------------------------------------ rates for the function
-- Should the function fetch now? Yes when the last success was before today (Israel), or before
-- 14:00 today while it's now past 14:00 (the Bank of Israel publishes ~13:30). A failed attempt
-- is retried after 30 minutes at the earliest, so an outage doesn't mean a fetch per request.
create function public.svc_fx_claim(p_now timestamptz) returns boolean
language plpgsql security definer set search_path = '' as $$
declare m public.fx_meta; loc timestamp := p_now at time zone 'Asia/Jerusalem'; s timestamp;
begin
  select * into m from public.fx_meta where id for update;
  s := m.last_success at time zone 'Asia/Jerusalem';
  if s is not null and s::date = loc::date and (extract(hour from s) >= 14 or extract(hour from loc) < 14) then
    return false;                                         -- today's rate is in
  end if;
  if m.last_attempt is not null and m.last_attempt > p_now - interval '30 minutes' then
    return false;                                         -- someone tried a moment ago
  end if;
  update public.fx_meta set last_attempt = p_now where id;
  return true;
end $$;

-- p_rows: [{currency, date, rate, source}] — upsert, then mark the fetch as a success.
create function public.svc_fx_put(p_rows jsonb, p_now timestamptz) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.fx_rates (rate_date, currency, ils_per_unit, source, fetched_at)
  select x.date, x.currency, round(x.rate, 6), x.source, p_now
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(currency text, date date, rate numeric, source text)
   where x.rate > 0 and x.currency ~ '^[A-Z]{3}$' and x.currency <> 'ILS'
  on conflict (currency, rate_date) do update
     set ils_per_unit = excluded.ils_per_unit, source = excluded.source, fetched_at = excluded.fetched_at
   where public.fx_rates.source = 'ecb' or excluded.source = 'boi';   -- an official BoI rate is never replaced by a cross rate
  get diagnostics n = row_count;
  if n > 0 then update public.fx_meta set last_success = p_now where id; end if;
  return n;
end $$;

-- The rate a household uses for a currency on a day: its manual rate, else the official rate of
-- that day (or the last one before it — weekends, holidays), else the earliest we have. null = none.
create function public.fx_rate_for(p_household uuid, p_currency text, p_on date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select ils_per_unit from public.fx_overrides where household_id = p_household and currency = p_currency),
    (select ils_per_unit from public.fx_rates where currency = p_currency and rate_date <= p_on order by rate_date desc limit 1),
    (select ils_per_unit from public.fx_rates where currency = p_currency order by rate_date limit 1))
$$;

-- Everything the app shows: the latest official rate per currency + the household's manual ones.
create function public.svc_fx_rates(p_household uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'official', coalesce((select jsonb_object_agg(r.currency, jsonb_build_object('rate', r.ils_per_unit, 'date', r.rate_date, 'source', r.source))
                            from (select distinct on (currency) currency, ils_per_unit, rate_date, source
                                    from public.fx_rates order by currency, rate_date desc) r), '{}'::jsonb),
    'manual', coalesce((select jsonb_object_agg(o.currency, jsonb_build_object('rate', o.ils_per_unit, 'date', (o.updated_at at time zone 'Asia/Jerusalem')::date))
                          from public.fx_overrides o where o.household_id = p_household), '{}'::jsonb),
    'last_success', (select last_success from public.fx_meta where id))
$$;

revoke execute on function public.svc_fx_claim(timestamptz), public.svc_fx_put(jsonb, timestamptz),
  public.fx_rate_for(uuid, text, date), public.svc_fx_rates(uuid) from public, anon, authenticated;
grant execute on function public.svc_fx_claim(timestamptz), public.svc_fx_put(jsonb, timestamptz),
  public.fx_rate_for(uuid, text, date), public.svc_fx_rates(uuid) to service_role;

-- ------------------------------------------------------------ statement import
-- Same as 0009's apply_statement, plus: rows carry original_amount / original_currency / fx_rate
-- (the statement's "סכום עסקה מקורי"), and merging a statement row into a logged foreign row
-- keeps the logged original and stores the card's actual rate (₪ charged ÷ original).
create or replace function public.apply_statement(p_household uuid, p_method uuid, p_rows jsonb, p_merges jsonb, p_leftovers uuid[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_ins int := 0; v_mer int := 0; v_left int := 0; v_want int := jsonb_array_length(coalesce(p_merges, '[]'::jsonb));
begin
  if not public.can_write(p_household) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_method is not null and not exists (select 1 from public.payment_methods where id = p_method and household_id = p_household) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.transactions (household_id, date, month, merchant, amount, category, is_fixed, note, person_id,
                                   source, source_title, status, payment_method_id, match_status, date_uncertain,
                                   original_amount, original_currency, fx_rate)
  select p_household, x.date, x.month, x.merchant, x.amount, x.category, coalesce(x.is_fixed, false), coalesce(x.note, ''),
         x.person_id, x.source, coalesce(x.source_title, ''), 'saved', p_method, 'none',
         x.date > current_date + 2 or x.date < current_date - 60,
         x.original_amount, x.original_currency, x.fx_rate
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(date date, month text, merchant text, amount numeric,
         category text, is_fixed boolean, note text, person_id uuid, source text, source_title text,
         original_amount numeric, original_currency text, fx_rate numeric);
  get diagnostics v_ins = row_count;
  update public.transactions t
     set amount = x.amount, date = x.date, month = x.month, match_status = 'matched',
         payment_method_id = coalesce(t.payment_method_id, p_method),
         date_uncertain = (x.date > current_date + 2 or x.date < current_date - 60),
         fx_rate = case when t.original_amount is null then null
                        else round(abs(x.amount / t.original_amount), 6) end
    from jsonb_to_recordset(coalesce(p_merges, '[]'::jsonb)) as x(id uuid, date date, month text, amount numeric)
   where t.id = x.id and t.household_id = p_household
     and t.match_status in ('awaiting_statement', 'unmatched_after_statement');
  get diagnostics v_mer = row_count;
  if v_mer <> v_want then
    raise exception 'match_stale' using errcode = 'P0001';   -- someone merged meanwhile: nothing is saved
  end if;
  update public.transactions set match_status = 'unmatched_after_statement'
   where household_id = p_household and id = any (coalesce(p_leftovers, '{}')) and match_status = 'awaiting_statement';
  get diagnostics v_left = row_count;
  return jsonb_build_object('inserted', v_ins, 'merged', v_mer, 'unmatched', v_left);
end $$;

-- ---------------------------------------------------------------- receipts
-- Same as 0009's svc_complete_receipt_job, plus: receipt.currency (ISO code from the model).
-- A foreign total keeps the original and is converted with fx_rate_for(receipt date). No rate at
-- all (never fetched, manual not set) → the amount stays the foreign number and the note says so;
-- receipts are always reviewed, so a person fixes it before it counts.
create or replace function public.svc_complete_receipt_job(
  p_job uuid, p_results jsonb, p_input int, p_output int, p_usd numeric
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.receipt_jobs;
  r jsonb; it jsonb; v_items jsonb := '[]'::jsonb;
  v_parsed int := 0; v_failed int := 0;
  v_date date; v_amount numeric; v_person uuid; v_cat text; v_tx uuid;
  v_uploaded date; v_uncertain boolean;
  v_cur text; v_rate numeric; v_orig numeric; v_note text;
begin
  select * into j from public.receipt_jobs where id = p_job for update;
  if not found or j.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;
  v_uploaded := (j.created_at at time zone 'Asia/Jerusalem')::date;
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
    if v_date is null then
      v_date := v_uploaded;
      v_uncertain := true;                                     -- unreadable date: this is a guess
    else
      v_uncertain := v_date > v_uploaded + 2 or v_date < v_uploaded - 60;  -- keep it either way, just flag it
    end if;
    v_cat := left(coalesce(nullif(btrim(r #>> '{receipt,category}'), ''), 'שונות'), 40);
    v_note := left(coalesce(r #>> '{receipt,note}', ''), 200);
    v_cur := upper(btrim(coalesce(r #>> '{receipt,currency}', 'ILS')));
    v_orig := null; v_rate := null;
    if v_cur ~ '^[A-Z]{3}$' and v_cur <> 'ILS' then
      v_rate := public.fx_rate_for(j.household_id, v_cur, v_date);
      if v_rate is not null then
        v_orig := v_amount;
        v_amount := round(v_orig * v_rate, 2);
      else
        v_note := left('סכום ב-' || v_cur || ', לא הומר לשקלים — צריך לתקן' ||
                       case when v_note <> '' then ' · ' || v_note else '' end, 200);
        v_cur := null;
      end if;
    else
      v_cur := null;
    end if;
    insert into public.transactions (household_id, date, month, merchant, amount, category, is_fixed, note,
                                     person_id, source, source_title, status, receipt_job_id,
                                     receipt_client_id, created_by, date_uncertain,
                                     original_amount, original_currency, fx_rate)
    values (j.household_id, v_date, to_char(v_date, 'YYYY-MM'),
            left(coalesce(nullif(btrim(r #>> '{receipt,merchant}'), ''), 'קבלה'), 120),
            v_amount, v_cat, false, v_note,
            v_person, 'receipt', 'קבלה', 'review', j.id, it->>'client_id', j.submitted_by, v_uncertain,
            v_orig, v_cur, v_rate)
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

-- ---------------------------------------------------------------- capture
-- Same as 0011's svc_capture, plus p_currency: a foreign amount (from the Apple Pay text, or a
-- quick add while the household is in trip mode — p_currency '' = "the trip currency if trip mode
-- is on, else ₪") is converted with fx_rate_for(today) and keeps the original.
-- No rate at all → saved unconverted, in review, and the note says so.
drop function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date);
create function public.svc_capture(
  p_token text, p_amount numeric, p_merchant text, p_card text, p_kind text, p_category text,
  p_category_known boolean, p_note text, p_date date, p_currency text default 'ILS'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.capture_tokens; v_role public.member_role; v_pm public.payment_methods; v_card text := btrim(coalesce(p_card, ''));
  v_id uuid; v_status text; v_match text; v_merchant text := left(btrim(coalesce(p_merchant, '')), 80);
  v_cur text := upper(btrim(coalesce(p_currency, 'ILS'))); v_rate numeric; v_orig numeric; v_amount numeric := round(p_amount, 2);
  v_note text := left(coalesce(p_note, ''), 200); v_unconverted boolean := false;
begin
  select * into t from public.capture_tokens where token_hash = public.token_hash(p_token) and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'bad_token'); end if;
  select role into v_role from public.household_members where household_id = t.household_id and user_id = t.user_id;
  if v_role is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_kind not in ('wallet', 'quick') or p_amount is null or p_amount = 0 or abs(p_amount) > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v_cur = '' then
    select case when trip_mode then trip_currency else 'ILS' end into v_cur from public.household_settings where household_id = t.household_id;
    v_cur := coalesce(v_cur, 'ILS');
  end if;
  if v_cur !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_merchant = '' then v_merchant := case when p_kind = 'quick' then 'הוספה מהירה' else 'Apple Pay' end; end if;
  update public.capture_tokens set last_used_at = now() where id = t.id;

  if v_cur <> 'ILS' then
    v_rate := public.fx_rate_for(t.household_id, v_cur, p_date);
    if v_rate is not null then
      v_orig := v_amount;
      v_amount := round(v_orig * v_rate, 2);
    else
      v_note := left('סכום ב-' || v_cur || ', לא הומר לשקלים — צריך לתקן' || case when v_note <> '' then ' · ' || v_note else '' end, 200);
      v_unconverted := true;
    end if;
  end if;

  -- the same purchase twice within 2 minutes (automation fired twice) → one row
  if exists (select 1 from public.transactions
              where household_id = t.household_id and source in ('wallet', 'quick') and amount = v_amount
                and lower(merchant) = lower(v_merchant) and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- payment method: the card/pass name the shortcut sends (label, issuer or last 4), else the default card
  if v_card <> '' then
    select * into v_pm from public.payment_methods
     where household_id = t.household_id and active
       and (lower(label) = lower(v_card) or (last4 is not null and v_card ~ ('(^|[^0-9])' || last4 || '($|[^0-9])'))
            or (issuer <> '' and v_card ilike '%' || issuer || '%') or (v_card in ('cash', 'מזומן') and type = 'cash'))
     order by (lower(label) = lower(v_card)) desc, sort limit 1;
  end if;
  if v_pm.id is null then
    select * into v_pm from public.payment_methods
     where household_id = t.household_id and active
       and type = case when p_kind = 'quick' then 'cash' else 'credit_card' end
     order by (person_id is not distinct from (select id from public.people where household_id = t.household_id and user_id = t.user_id limit 1)) desc, sort
     limit 1;
  end if;
  v_match := case when v_pm.type in ('credit_card', 'debit_card', 'bank_transfer', 'standing_order', 'bit_paybox') then 'awaiting_statement' else 'none' end;
  -- wallet rows are reviewed unless the merchant matched a category rule; a quick add is the user's own choice;
  -- an amount we couldn't convert is always reviewed
  v_status := case when v_unconverted then 'review' when p_kind = 'quick' or p_category_known then 'saved' else 'review' end;

  insert into public.transactions (household_id, date, month, merchant, amount, category, note, person_id, source, source_title,
                                   status, created_by, payment_method_id, match_status, original_amount, original_currency, fx_rate)
  values (t.household_id, p_date, to_char(p_date, 'YYYY-MM'), v_merchant, v_amount, coalesce(p_category, 'שונות'),
          v_note,
          (select id from public.people where household_id = t.household_id and user_id = t.user_id limit 1),
          p_kind, case when p_kind = 'wallet' then 'Apple Pay (קיצור דרך)' else 'הוספה מהירה (קיצור דרך)' end,
          v_status, t.user_id, v_pm.id, v_match,
          v_orig, case when v_orig is null then null else v_cur end, case when v_orig is null then null else v_rate end)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'status', v_status, 'method', v_pm.label,
                            'household_id', t.household_id, 'amount', v_amount,
                            'original_amount', v_orig, 'currency', case when v_orig is null then 'ILS' else v_cur end);
end $$;

revoke execute on function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date, text) from public, anon, authenticated;
grant execute on function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date, text) to service_role;
