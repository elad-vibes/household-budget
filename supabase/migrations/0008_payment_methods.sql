-- ============================================================================
-- 0008_payment_methods.sql — payment methods + no double counting
-- (payment-methods.md, Elad 2026-09-27).
--   * payment_methods per household (cash / cards / bank / bit …), RLS like the
--     other household tables + the aal2 gate. Never a full card number: last4 only.
--   * transactions: payment_method_id, match_status, matched_transaction_id
--     (audit: the statement row that was merged in), payment_hint (from receipts)
--   * fixed_expenses: payment_method_id
--   * merge model: the logged row (receipt / manual) SURVIVES and takes the
--     statement's amount + date; the statement row is not inserted (import) or
--     is deleted (statement imported first). apply_statement / merge_statement_row
--     run as the caller (security invoker → RLS applies) in one transaction.
--   * new excluded category "משיכת מזומן" (ATM = moving money to cash, not an expense)
-- ============================================================================

create table public.payment_methods (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  type          text not null check (type in ('cash', 'credit_card', 'debit_card', 'bank_transfer',
                                              'standing_order', 'bit_paybox', 'other')),
  label         text not null check (char_length(btrim(label)) between 1 and 40),
  issuer        text not null default '' check (char_length(issuer) <= 30),
  last4         text null check (last4 ~ '^[0-9]{4}$'),
  person_id     uuid null,                                   -- whose card (null = joint)
  active        boolean not null default true,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, person_id) references public.people (household_id, id) on delete set null (person_id)
);
create index payment_methods_household_idx on public.payment_methods (household_id, sort);

alter table public.payment_methods enable row level security;
create policy payment_methods_select on public.payment_methods for select to authenticated using (public.is_member(household_id));
create policy payment_methods_insert on public.payment_methods for insert to authenticated with check (public.can_write(household_id));
create policy payment_methods_update on public.payment_methods for update to authenticated
  using (public.can_write(household_id)) with check (public.can_write(household_id));
create policy payment_methods_delete on public.payment_methods for delete to authenticated using (public.can_write(household_id));
create policy mfa_gate on public.payment_methods as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));

revoke all on public.payment_methods from anon, authenticated;
grant select, insert, delete on public.payment_methods to authenticated;
grant update (type, label, issuer, last4, person_id, active, sort) on public.payment_methods to authenticated;
grant all on public.payment_methods to service_role;

-- Every household starts with the methods that need no details.
create function public.default_payment_methods(p_household uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.payment_methods (household_id, type, label, sort) values
    (p_household, 'cash', 'מזומן', 1), (p_household, 'bit_paybox', 'ביט / פייבוקס', 90),
    (p_household, 'bank_transfer', 'העברה', 91), (p_household, 'other', 'אחר', 99)
$$;
create function public.households_default_methods() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.default_payment_methods(new.id);
  return new;
end $$;
create trigger households_default_methods after insert on public.households
  for each row execute function public.households_default_methods();
select public.default_payment_methods(id) from public.households;

-- ------------------------------------------------------------ transactions
alter table public.transactions
  add column payment_method_id      uuid null,
  add column match_status           text not null default 'none'
                                    check (match_status in ('none', 'awaiting_statement', 'matched', 'unmatched_after_statement')),
  add column matched_transaction_id uuid null,
  add column payment_hint           text not null default '' check (char_length(payment_hint) <= 40),
  add foreign key (household_id, payment_method_id)
    references public.payment_methods (household_id, id) on delete set null (payment_method_id);
create index transactions_waiting_idx on public.transactions (household_id)
  where match_status in ('awaiting_statement', 'unmatched_after_statement');
grant update (payment_method_id, match_status, matched_transaction_id) on public.transactions to authenticated;  -- updated_at: touch_updated_at trigger

alter table public.fixed_expenses
  add column payment_method_id uuid null,
  add foreign key (household_id, payment_method_id)
    references public.payment_methods (household_id, id) on delete set null (payment_method_id);

-- ------------------------------------------------------------ receipts
-- Receipt line items → price history (as in 0006) + the payment hint the model
-- read ("אשראי ****1234", "מזומן") → prefills the method; the user confirms on approval.
create or replace function public.svc_after_receipt_tx(p_household uuid, p_tx uuid, p_receipt jsonb, p_date date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  it jsonb; v_name text; v_store text := left(coalesce(p_receipt->>'merchant', ''), 80);
  v_hint text := left(btrim(coalesce(p_receipt->>'payment', '')), 40); v_pm uuid; v_n int;
begin
  for it in select * from jsonb_array_elements(coalesce(p_receipt->'items', '[]'::jsonb)) limit 120 loop
    v_name := left(btrim(coalesce(it->>'name', '')), 80);
    if v_name = '' then continue; end if;
    begin
      insert into public.receipt_items (household_id, transaction_id, name, norm_name, qty, unit_price, total, store, date)
      values (p_household, p_tx, v_name, public.norm_item(v_name),
              coalesce(nullif(it->>'qty', '')::numeric, 1), nullif(it->>'unit_price', '')::numeric,
              nullif(it->>'total', '')::numeric, v_store, p_date);
    exception when others then null; -- a malformed line never blocks the receipt itself
    end;
  end loop;
  if v_hint = '' then return; end if;
  select (array_agg(id))[1], count(*) into v_pm, v_n from public.payment_methods
   where household_id = p_household and active and last4 is not null
     and v_hint ~ ('(^|[^0-9])' || last4 || '($|[^0-9])');
  if v_n <> 1 then v_pm := null; end if;
  if v_pm is null and v_hint ~* 'מזומן|cash' then
    select id into v_pm from public.payment_methods where household_id = p_household and active and type = 'cash' order by sort limit 1;
  end if;
  if v_pm is null and v_hint ~* 'ביט|bit|paybox|פייבוקס' then
    select id into v_pm from public.payment_methods where household_id = p_household and active and type = 'bit_paybox' order by sort limit 1;
  end if;
  update public.transactions set payment_hint = v_hint, payment_method_id = coalesce(v_pm, payment_method_id)
   where id = p_tx and household_id = p_household;
end $$;

-- ------------------------------------------------------------ statement import
-- p_rows:      new statement rows to insert (all tagged with p_method)
-- p_merges:    [{id, date, month, amount}] — waiting rows that ARE a statement row:
--              they take the statement's amount/date and become 'matched'
-- p_leftovers: waiting rows the statement should have contained but didn't
create function public.apply_statement(p_household uuid, p_method uuid, p_rows jsonb, p_merges jsonb, p_leftovers uuid[])
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
                                   source, source_title, status, payment_method_id, match_status)
  select p_household, x.date, x.month, x.merchant, x.amount, x.category, coalesce(x.is_fixed, false), coalesce(x.note, ''),
         x.person_id, x.source, coalesce(x.source_title, ''), 'saved', p_method, 'none'
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(date date, month text, merchant text, amount numeric,
         category text, is_fixed boolean, note text, person_id uuid, source text, source_title text);
  get diagnostics v_ins = row_count;
  update public.transactions t
     set amount = x.amount, date = x.date, month = x.month, match_status = 'matched',
         payment_method_id = coalesce(t.payment_method_id, p_method)
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

-- Statement first, receipt later: the logged row takes over the saved statement row.
create function public.merge_statement_row(p_keep uuid, p_statement uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare k public.transactions; s public.transactions;
begin
  select * into k from public.transactions where id = p_keep for update;
  select * into s from public.transactions where id = p_statement for update;
  if k.id is null or s.id is null or k.household_id <> s.household_id or k.id = s.id
     or s.source not in ('import', 'statement') or s.match_status <> 'none' or k.source in ('import', 'statement') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.transactions
     set amount = s.amount, date = s.date, month = s.month, match_status = 'matched', matched_transaction_id = s.id,
         payment_method_id = coalesce(k.payment_method_id, s.payment_method_id)
   where id = k.id;
  delete from public.transactions where id = s.id;
  if not found then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
end $$;

revoke execute on function public.apply_statement(uuid, uuid, jsonb, jsonb, uuid[]), public.merge_statement_row(uuid, uuid),
  public.default_payment_methods(uuid), public.households_default_methods() from public, anon, authenticated;
grant execute on function public.apply_statement(uuid, uuid, jsonb, jsonb, uuid[]), public.merge_statement_row(uuid, uuid) to authenticated;
grant execute on all functions in schema public to service_role;

-- ------------------------------------------------------------ weekly summary
-- Same function as 0006; "משיכת מזומן" joins the categories that are not expenses.
create or replace function public.svc_due_notifications(p_now timestamptz default now())
returns table (queue_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, title text, body text, url text, tag text)
language plpgsql security definer set search_path = '' as $$
declare
  m record; pr public.notification_prefs; loc timestamp; wk numeric; mo numeric; f record; a record;
  due date; today date;
begin
  for m in select distinct hm.user_id, hm.household_id from public.household_members hm
           where exists (select 1 from public.push_subscriptions s where s.user_id = hm.user_id) loop
    pr := public.prefs_of(m.user_id);
    loc := p_now at time zone pr.tz;
    today := loc::date;
    -- weekly summary on the chosen day, from 09:00
    if pr.weekly_summary and extract(dow from loc) = pr.weekly_day and extract(hour from loc) >= 9 then
      select coalesce(sum(amount), 0) into wk from public.transactions
       where household_id = m.household_id and status = 'saved' and date > today - 7 and date <= today
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות', 'משיכת מזומן');
      select coalesce(sum(amount), 0) into mo from public.transactions
       where household_id = m.household_id and status = 'saved' and month = to_char(loc, 'YYYY-MM')
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות', 'משיכת מזומן');
      insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
      values (m.user_id, m.household_id, 'weekly', 'סיכום שבועי',
              'השבוע יצאו ' || round(wk)::text || ' ₪. מתחילת החודש: ' || round(mo)::text || ' ₪.', './#/overview',
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
                  'בעוד ' || (due - today)::text || ' ימים, בערך ' || round(f.amount)::text || ' ₪.', './#/fixed',
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
                  to_char(due, 'DD/MM') || ' · בערך ' || round(a.amount)::text || ' ₪.', './#/plan',
                  a.id::text || ':' || extract(year from due)::text)
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
