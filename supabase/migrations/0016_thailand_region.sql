-- ============================================================================
-- 0016_thailand_region.sql — household region (DECISIONS #42).
--   * household_settings.region: 'IL' (every household before this migration, the default) or 'TH'. It picks the
--     base currency (ILS / THB), the time zone (Asia/Jerusalem / Asia/Bangkok), the default payment methods and
--     the local rules in the app. transactions.amount is ALWAYS in the household's base currency (unchanged rule).
--   * The region can only be set while the household has no money data (transactions, fixed expenses, budgets,
--     annual expenses, goals, vouchers): switching later would silently re-label every amount. Owner / super-admin only.
--   * Foreign currency (0015) is generalized: "foreign" = "not the base currency". The shared fx_rates cache stays
--     "₪ per 1 unit" (the Bank of Israel + ECB feeds are quoted that way); for another base the rate is a CROSS rate
--     through the shekel: (₪ per foreign) ÷ (₪ per base). A manual rate (fx_overrides.ils_per_unit — the column name is
--     historical) is always "base units per 1 foreign unit". For region IL every number is exactly what it was.
--   * New payment method type 'e_wallet' (PromptPay / Thai QR, TrueMoney Wallet, Rabbit LINE Pay).
--   * Notifications: amounts use the household's currency sign; a new user's default time zone follows the region.
-- ============================================================================

alter table public.household_settings
  add column region text not null default 'IL' check (region in ('IL', 'TH'));
grant update (region) on public.household_settings to authenticated;

-- ------------------------------------------------------------ helpers
create function public.base_currency(p_household uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case coalesce((select region from public.household_settings where household_id = p_household), 'IL') when 'TH' then 'THB' else 'ILS' end
$$;
create function public.base_symbol(p_household uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case public.base_currency(p_household) when 'THB' then '฿' else '₪' end
$$;
create function public.region_tz(p_household uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case coalesce((select region from public.household_settings where household_id = p_household), 'IL') when 'TH' then 'Asia/Bangkok' else 'Asia/Jerusalem' end
$$;
create function public.svc_household_region(p_household uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select region from public.household_settings where household_id = p_household), 'IL')
$$;
create function public.svc_capture_region(p_token text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.region from public.capture_tokens t join public.household_settings s on s.household_id = t.household_id
                    where t.token_hash = public.token_hash(p_token) and t.revoked_at is null), 'IL')
$$;
revoke execute on function public.base_currency(uuid), public.base_symbol(uuid), public.region_tz(uuid),
  public.svc_household_region(uuid), public.svc_capture_region(text) from public, anon, authenticated;
grant execute on function public.base_currency(uuid), public.base_symbol(uuid), public.region_tz(uuid),
  public.svc_household_region(uuid), public.svc_capture_region(text) to service_role;

-- ------------------------------------------------------------ "not the base currency" (was: not ILS)
-- The 0015 column checks said <> 'ILS'. A Thailand household's foreign currency may be ILS, and its own base (THB) must be
-- refused instead, so the fixed check is replaced by a trigger that asks the household's base.
do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint
            where contype = 'c' and conrelid in ('public.transactions'::regclass, 'public.household_settings'::regclass, 'public.fx_overrides'::regclass)
              and pg_get_constraintdef(oid) like '%<> ''ILS''%' loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

-- (those checks also carried the 3-letter format rule: put it back on its own)
alter table public.transactions add constraint transactions_original_currency_format check (original_currency ~ '^[A-Z]{3}$');
alter table public.household_settings add constraint household_settings_trip_currency_format check (trip_currency ~ '^[A-Z]{3}$');
alter table public.fx_overrides add constraint fx_overrides_currency_format check (currency ~ '^[A-Z]{3}$');

create function public.currency_not_base() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_cur text;
begin
  v_cur := to_jsonb(new) ->> case tg_table_name when 'household_settings' then 'trip_currency'
                                                when 'transactions' then 'original_currency'
                                                else 'currency' end;
  if v_cur is not null and v_cur = public.base_currency(new.household_id) then
    raise exception 'violates check constraint: the foreign currency must differ from the household base currency' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger transactions_currency_not_base before insert or update of original_currency, household_id on public.transactions
  for each row when (new.original_currency is not null) execute function public.currency_not_base();
create trigger fx_overrides_currency_not_base before insert or update of currency on public.fx_overrides
  for each row execute function public.currency_not_base();
create trigger settings_trip_currency_not_base before update of trip_currency on public.household_settings
  for each row execute function public.currency_not_base();

-- ------------------------------------------------------------ payment methods
alter table public.payment_methods drop constraint payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check check (type in ('cash', 'credit_card', 'debit_card',
  'bank_transfer', 'standing_order', 'bit_paybox', 'other', 'voucher', 'e_wallet'));

-- Defaults per region. The creation trigger (0008) calls it with one argument → Israel, as before.
drop function public.default_payment_methods(uuid);
create function public.default_payment_methods(p_household uuid, p_region text default 'IL') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_region = 'TH' then
    insert into public.payment_methods (household_id, type, label, issuer, sort) values
      (p_household, 'cash', 'מזומן', '', 1),
      (p_household, 'e_wallet', 'PromptPay / Thai QR', 'PromptPay', 20),
      (p_household, 'e_wallet', 'TrueMoney Wallet', 'TrueMoney', 21),
      (p_household, 'e_wallet', 'Rabbit LINE Pay', 'Rabbit LINE Pay', 22),
      (p_household, 'bank_transfer', 'העברה בנקאית', '', 91),
      (p_household, 'other', 'אחר', '', 99);
  else
    insert into public.payment_methods (household_id, type, label, sort) values
      (p_household, 'cash', 'מזומן', 1), (p_household, 'bit_paybox', 'ביט / פייבוקס', 90),
      (p_household, 'bank_transfer', 'העברה', 91), (p_household, 'other', 'אחר', 99);
  end if;
end $$;
revoke execute on function public.default_payment_methods(uuid, text) from public, anon, authenticated;
grant execute on function public.default_payment_methods(uuid, text) to service_role;

-- ------------------------------------------------------------ changing the region
create function public.settings_region_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare h uuid := new.household_id;
begin
  if new.region is not distinct from old.region then return new; end if;
  if auth.uid() is not null and not (public.is_owner(h) or public.is_super_admin()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.transactions where household_id = h)
     or exists (select 1 from public.fixed_expenses where household_id = h)
     or exists (select 1 from public.budgets where household_id = h)
     or exists (select 1 from public.annual_expenses where household_id = h)
     or exists (select 1 from public.savings_goals where household_id = h)
     or exists (select 1 from public.vouchers where household_id = h) then
    raise exception 'region_locked' using errcode = 'P0001';   -- amounts already exist in the old currency
  end if;
  new.trip_mode := false;
  new.trip_currency := case new.region when 'TH' then 'ILS' else 'THB' end;   -- never the base currency
  delete from public.fx_overrides where household_id = h;                     -- quoted in the old base
  return new;
end $$;
create trigger settings_region_before before update of region on public.household_settings
  for each row execute function public.settings_region_before();

-- After: swap the untouched default payment methods for the new region's, and move the members' time zone.
create function public.settings_region_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.region is not distinct from old.region then return null; end if;
  delete from public.payment_methods
   where household_id = new.household_id and type <> 'voucher' and last4 is null
     and ((type = 'cash' and label = 'מזומן') or (type = 'bit_paybox' and label = 'ביט / פייבוקס')
          or (type = 'bank_transfer' and label in ('העברה', 'העברה בנקאית')) or (type = 'other' and label = 'אחר')
          or (type = 'e_wallet' and label in ('PromptPay / Thai QR', 'TrueMoney Wallet', 'Rabbit LINE Pay')));
  perform public.default_payment_methods(new.household_id, new.region);
  update public.notification_prefs p
     set tz = case new.region when 'TH' then 'Asia/Bangkok' else 'Asia/Jerusalem' end
   where p.user_id in (select user_id from public.household_members where household_id = new.household_id)
     and p.tz in ('Asia/Jerusalem', 'Asia/Bangkok');
  return null;
end $$;
create trigger settings_region_after after update of region on public.household_settings
  for each row execute function public.settings_region_after();

-- ------------------------------------------------------------ exchange rates in the household's base
-- ₪ per 1 unit of a currency on a day (the cache's own unit): the last rate on or before the day, else the earliest; ILS = 1.
create function public.fx_ils_per(p_currency text, p_on date) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_currency = 'ILS' then 1::numeric else coalesce(
    (select ils_per_unit from public.fx_rates where currency = p_currency and rate_date <= p_on order by rate_date desc limit 1),
    (select ils_per_unit from public.fx_rates where currency = p_currency order by rate_date limit 1)) end
$$;

-- The rate a household uses for a currency on a day, in ITS base currency: its manual rate, else the official one.
-- base ILS: exactly 0015's lookup. Other base: cross rate through the shekel, rounded to 6 places. null = none.
create or replace function public.fx_rate_for(p_household uuid, p_currency text, p_on date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_base text := public.base_currency(p_household); v_man numeric; v_f numeric; v_b numeric;
begin
  select ils_per_unit into v_man from public.fx_overrides where household_id = p_household and currency = p_currency;
  if v_man is not null then return v_man; end if;
  if v_base = 'ILS' then
    return coalesce(
      (select ils_per_unit from public.fx_rates where currency = p_currency and rate_date <= p_on order by rate_date desc limit 1),
      (select ils_per_unit from public.fx_rates where currency = p_currency order by rate_date limit 1));
  end if;
  v_f := public.fx_ils_per(p_currency, p_on);
  v_b := public.fx_ils_per(v_base, p_on);
  if v_f is null or v_b is null or v_b = 0 then return null; end if;
  return round(v_f / v_b, 6);
end $$;

-- Everything the app shows: the latest official rate per currency in the household's base + its manual ones.
create or replace function public.svc_fx_rates(p_household uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_base text := public.base_currency(p_household); v_official jsonb;
begin
  if v_base = 'ILS' then
    v_official := coalesce((select jsonb_object_agg(r.currency, jsonb_build_object('rate', r.ils_per_unit, 'date', r.rate_date, 'source', r.source))
                              from (select distinct on (currency) currency, ils_per_unit, rate_date, source
                                      from public.fx_rates order by currency, rate_date desc) r), '{}'::jsonb);
  else
    with latest as (select distinct on (currency) currency, ils_per_unit, rate_date, source
                      from public.fx_rates order by currency, rate_date desc),
         b as (select ils_per_unit, rate_date, source from latest where currency = v_base),
         c as (select currency, ils_per_unit, rate_date, source from latest where currency <> v_base
               union all select 'ILS', 1::numeric, (select rate_date from b), (select source from b) where exists (select 1 from b))
    select coalesce(jsonb_object_agg(c.currency, jsonb_build_object(
             'rate', round(c.ils_per_unit / b.ils_per_unit, 6),
             'date', least(c.rate_date, b.rate_date),
             'source', case when c.source = 'ecb' and b.source = 'ecb' then 'ecb' else 'cross' end)), '{}'::jsonb)
      into v_official from c cross join b;
  end if;
  return jsonb_build_object(
    'base', v_base,
    'official', v_official,
    'manual', coalesce((select jsonb_object_agg(o.currency, jsonb_build_object('rate', o.ils_per_unit, 'date', (o.updated_at at time zone public.region_tz(p_household))::date))
                          from public.fx_overrides o where o.household_id = p_household), '{}'::jsonb),
    'last_success', (select last_success from public.fx_meta where id));
end $$;

-- ------------------------------------------------------------ budget alerts (symbol)
-- Same as 0013's budget_check; the text uses the household's currency sign.
create or replace function public.budget_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b numeric; spent numeric; lvl smallint; inserted int; st smallint; bm text; sym text;
begin
  if new.status <> 'saved' then return new; end if;
  select amount into b from public.budgets where household_id = new.household_id and category = new.category;
  if b is null then return new; end if;
  st := public.month_start_of(new.household_id);
  bm := public.budget_month(new.date, new.month, st);
  select coalesce(sum(amount), 0) into spent from public.transactions
   where household_id = new.household_id and category = new.category and status = 'saved'
     and public.budget_month(date, month, st) = bm;
  lvl := case when spent >= b then 100 when spent >= b * 0.8 then 80 else null end;
  if lvl is null then return new; end if;
  insert into public.budget_alerts (household_id, category, month, level) values (new.household_id, new.category, bm, lvl)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    sym := public.base_symbol(new.household_id);
    perform public.enqueue_household(new.household_id, 'budget',
      case when lvl = 100 then 'עברתם את התקציב' else 'קרוב לתקציב' end,
      new.category || ': ' || round(spent)::text || ' ' || sym || ' מתוך ' || round(b)::text || ' ' || sym || ' (' || round(spent / b * 100)::text || '%)',
      './#/plan', new.category || ':' || bm || ':' || lvl);
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ notifications (symbol)
-- Same as 0014's svc_due_notifications; the amounts use the household's currency sign (sym).
create or replace function public.svc_due_notifications(p_now timestamptz default now())
returns table (queue_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, title text, body text, url text, tag text)
language plpgsql security definer set search_path = '' as $$
declare
  m record; pr public.notification_prefs; loc timestamp; wk numeric; mo numeric; f record; a record;
  due date; today date; st smallint; v record; d int; win int; sym text;
begin
  for m in select distinct hm.user_id, hm.household_id from public.household_members hm
           where exists (select 1 from public.push_subscriptions s where s.user_id = hm.user_id) loop
    pr := public.prefs_of(m.user_id);
    sym := public.base_symbol(m.household_id);
    loc := p_now at time zone pr.tz;
    today := loc::date;
    -- weekly summary on the chosen day, from 09:00
    if pr.weekly_summary and extract(dow from loc) = pr.weekly_day and extract(hour from loc) >= 9 then
      st := public.month_start_of(m.household_id);
      select coalesce(sum(amount), 0) into wk from public.transactions
       where household_id = m.household_id and status = 'saved' and date > today - 7 and date <= today
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות', 'משיכת מזומן');
      select coalesce(sum(amount), 0) into mo from public.transactions
       where household_id = m.household_id and status = 'saved'
         and public.budget_month(date, month, st) = public.budget_month(today, to_char(today, 'YYYY-MM'), st)
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות', 'משיכת מזומן');
      insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
      values (m.user_id, m.household_id, 'weekly', 'סיכום שבועי',
              'השבוע יצאו ' || round(wk)::text || ' ' || sym || '. מתחילת החודש: ' || round(mo)::text || ' ' || sym || '.', './#/overview',
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
                  'בעוד ' || (due - today)::text || ' ימים, בערך ' || round(f.amount)::text || ' ' || sym || '.', './#/fixed',
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
                  to_char(due, 'DD/MM') || ' · בערך ' || round(a.amount)::text || ' ' || sym || '.', './#/plan',
                  a.id::text || ':' || extract(year from due)::text)
          on conflict do nothing;
        end if;
      end loop;
    end if;
    if pr.bills then
      for v in select id, name, balance, expires_on from public.vouchers
               where household_id = m.household_id and not archived and balance > 0 and expires_on is not null loop
        d := v.expires_on - today;
        win := case when d < 0 or d > 30 then null when d <= 1 then 1 when d <= 7 then 7 else 30 end;
        if win is not null then
          insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
          values (m.user_id, m.household_id, 'voucher', 'שובר עומד לפוג: ' || left(v.name, 40),
                  case when d = 0 then 'היום' when d = 1 then 'מחר' else 'בעוד ' || d::text || ' ימים' end
                    || ' · יתרה ' || round(v.balance)::text || ' ' || sym || '.', './#/plan',
                  v.id::text || ':' || win::text)
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

-- ------------------------------------------------------------ receipts
-- Same as 0015's svc_complete_receipt_job, but "foreign" means "not the household's base currency" and the upload day is
-- the day in the household's time zone. A receipt with no readable currency is in the base currency.
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
  v_cur text; v_rate numeric; v_orig numeric; v_note text; v_base text; v_tz text;
begin
  select * into j from public.receipt_jobs where id = p_job for update;
  if not found or j.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;
  v_base := public.base_currency(j.household_id);
  v_tz := public.region_tz(j.household_id);
  v_uploaded := (j.created_at at time zone v_tz)::date;
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
    v_cur := upper(btrim(coalesce(r #>> '{receipt,currency}', '')));
    if v_cur !~ '^[A-Z]{3}$' then v_cur := v_base; end if;
    v_orig := null; v_rate := null;
    if v_cur <> v_base then
      v_rate := public.fx_rate_for(j.household_id, v_cur, v_date);
      if v_rate is not null then
        v_orig := v_amount;
        v_amount := round(v_orig * v_rate, 2);
      else
        v_note := left('סכום ב-' || v_cur || ', לא הומר ' || case when v_base = 'ILS' then 'לשקלים' else 'לבאט' end || ' — צריך לתקן' ||
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

-- ------------------------------------------------------------ capture
-- Same as 0015's svc_capture; the base currency is the household's (p_currency '' = the trip currency while trip mode
-- is on, else the base) and e_wallet rows wait for their statement like cards do.
drop function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date, text);
create function public.svc_capture(
  p_token text, p_amount numeric, p_merchant text, p_card text, p_kind text, p_category text,
  p_category_known boolean, p_note text, p_date date, p_currency text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.capture_tokens; v_role public.member_role; v_pm public.payment_methods; v_card text := btrim(coalesce(p_card, ''));
  v_id uuid; v_status text; v_match text; v_merchant text := left(btrim(coalesce(p_merchant, '')), 80);
  v_cur text := upper(btrim(coalesce(p_currency, ''))); v_base text; v_rate numeric; v_orig numeric; v_amount numeric := round(p_amount, 2);
  v_note text := left(coalesce(p_note, ''), 200); v_unconverted boolean := false;
begin
  select * into t from public.capture_tokens where token_hash = public.token_hash(p_token) and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'bad_token'); end if;
  select role into v_role from public.household_members where household_id = t.household_id and user_id = t.user_id;
  if v_role is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_kind not in ('wallet', 'quick') or p_amount is null or p_amount = 0 or abs(p_amount) > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  v_base := public.base_currency(t.household_id);
  if v_cur = '' then
    select case when trip_mode then trip_currency else v_base end into v_cur from public.household_settings where household_id = t.household_id;
    v_cur := coalesce(v_cur, v_base);
  end if;
  if v_cur !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_merchant = '' then v_merchant := case when p_kind = 'quick' then 'הוספה מהירה' else 'Apple Pay' end; end if;
  update public.capture_tokens set last_used_at = now() where id = t.id;

  if v_cur <> v_base then
    v_rate := public.fx_rate_for(t.household_id, v_cur, p_date);
    if v_rate is not null then
      v_orig := v_amount;
      v_amount := round(v_orig * v_rate, 2);
    else
      v_note := left('סכום ב-' || v_cur || ', לא הומר ' || case when v_base = 'ILS' then 'לשקלים' else 'לבאט' end || ' — צריך לתקן' || case when v_note <> '' then ' · ' || v_note else '' end, 200);
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
  v_match := case when v_pm.type in ('credit_card', 'debit_card', 'bank_transfer', 'standing_order', 'bit_paybox', 'e_wallet') then 'awaiting_statement' else 'none' end;
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
                            'original_amount', v_orig, 'currency', case when v_orig is null then v_base else v_cur end);
end $$;
revoke execute on function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date, text) from public, anon, authenticated;
grant execute on function public.svc_capture(text, numeric, text, text, text, text, boolean, text, date, text) to service_role;
revoke execute on function public.fx_ils_per(text, date) from public, anon, authenticated;
grant execute on function public.fx_ils_per(text, date) to service_role;

-- ------------------------------------------------------------ notification preferences
-- A person who never saved preferences gets their household's time zone (and a Monday summary for Thailand,
-- Sunday for Israel — the first working day of each). Saved preferences are never touched.
create or replace function public.prefs_of(p_user uuid) returns public.notification_prefs
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p from public.notification_prefs p where p.user_id = p_user),
    row(p_user, true, true, true, true,
        (case when (select public.region_tz(hm.household_id) from public.household_members hm where hm.user_id = p_user order by hm.joined_at limit 1) = 'Asia/Bangkok' then 1 else 0 end)::smallint,
        22::smallint, 7::smallint,
        coalesce((select public.region_tz(hm.household_id) from public.household_members hm where hm.user_id = p_user order by hm.joined_at limit 1), 'Asia/Jerusalem'),
        now())::public.notification_prefs)
$$;
