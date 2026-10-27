-- 0014: ארנק שוברים — vouchers / gift cards / store credit (next-features.md §4).
--   * vouchers: name, issuer, initial amount, balance (kept by trigger), currency, expiry,
--     note, code_last4 (never the full code). RLS like the other household tables + aal2 gate.
--   * every voucher gets its own payment method (type 'voucher'), so it shows up in the
--     existing "איך שילמת?" chips. A SAVED transaction paid with it = one voucher_uses row
--     (kept in sync by trigger: amount, date, method change, review → saved, delete).
--   * manual uses / corrections (negative = top-up) straight into voucher_uses.
--   * push reminders 30 / 7 / 1 days before expiry while there is a balance (svc_due_notifications).
--   * a voucher is never a statement item: the matcher treats 'voucher' like cash (no waiting).

alter table public.payment_methods drop constraint payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check check (type in ('cash', 'credit_card', 'debit_card',
  'bank_transfer', 'standing_order', 'bit_paybox', 'other', 'voucher'));

alter table public.notification_queue drop constraint notification_queue_kind_check;
alter table public.notification_queue add constraint notification_queue_kind_check
  check (kind in ('receipts', 'budget', 'bill', 'annual', 'weekly', 'test', 'voucher'));

create table public.vouchers (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households (id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 60),
  issuer             text not null default '' check (char_length(issuer) <= 40),
  initial_amount     numeric(10,2) not null check (initial_amount > 0 and initial_amount <= 100000),
  balance            numeric(10,2) not null default 0,
  currency           text not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  expires_on         date null,
  note               text not null default '' check (char_length(note) <= 200),
  code_last4         text null check (code_last4 ~ '^[0-9A-Za-z]{4}$'),   -- never the full code
  payment_method_id  uuid null,
  archived           boolean not null default false,
  created_by         uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, payment_method_id) references public.payment_methods (household_id, id) on delete set null (payment_method_id)
);
create index vouchers_household_idx on public.vouchers (household_id, expires_on);

create table public.voucher_uses (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null,
  voucher_id      uuid not null,
  transaction_id  uuid null unique,
  amount          numeric(10,2) not null check (amount <> 0 and abs(amount) <= 100000),   -- negative = top-up / correction
  date            date not null default current_date,
  note            text not null default '' check (char_length(note) <= 120),
  created_by      uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  foreign key (household_id, voucher_id) references public.vouchers (household_id, id) on delete cascade,
  foreign key (household_id, transaction_id) references public.transactions (household_id, id) on delete cascade
);
create index voucher_uses_voucher_idx on public.voucher_uses (voucher_id, date desc);

alter table public.vouchers enable row level security;
alter table public.voucher_uses enable row level security;
create policy vouchers_select on public.vouchers for select to authenticated using (public.is_member(household_id));
create policy vouchers_insert on public.vouchers for insert to authenticated with check (public.can_write(household_id));
create policy vouchers_update on public.vouchers for update to authenticated
  using (public.can_write(household_id)) with check (public.can_write(household_id));
create policy vouchers_delete on public.vouchers for delete to authenticated using (public.can_write(household_id));
create policy mfa_gate on public.vouchers as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
create policy voucher_uses_select on public.voucher_uses for select to authenticated using (public.is_member(household_id));
-- manual uses only; rows tied to a transaction are written by the trigger
create policy voucher_uses_insert on public.voucher_uses for insert to authenticated
  with check (public.can_write(household_id) and transaction_id is null and created_by = auth.uid());
create policy voucher_uses_delete on public.voucher_uses for delete to authenticated
  using (public.can_write(household_id) and transaction_id is null);
create policy mfa_gate on public.voucher_uses as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));

revoke all on public.vouchers, public.voucher_uses from anon, authenticated;
grant select, insert, delete on public.vouchers to authenticated;
grant update (name, issuer, initial_amount, currency, expires_on, note, code_last4, archived) on public.vouchers to authenticated;
grant select, insert (household_id, voucher_id, amount, date, note), delete on public.voucher_uses to authenticated;
grant all on public.vouchers, public.voucher_uses to service_role;

-- balance = initial amount − all uses (recomputed, never trusted from the client)
create function public.voucher_recalc(p_voucher uuid) returns void
language sql security definer set search_path = '' as $$
  update public.vouchers v
     set balance = v.initial_amount - coalesce((select sum(u.amount) from public.voucher_uses u where u.voucher_id = v.id), 0)
   where v.id = p_voucher
$$;
revoke all on function public.voucher_recalc(uuid) from public, anon, authenticated;
create function public.voucher_uses_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.voucher_recalc(old.voucher_id); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform public.voucher_recalc(new.voucher_id); end if;
  return null;
end $$;
create trigger voucher_uses_after after insert or update or delete on public.voucher_uses
  for each row execute function public.voucher_uses_after();

-- a new voucher gets its own payment method; the balance is always derived
create function public.vouchers_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pm uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.payment_methods (household_id, type, label, sort)
      values (new.household_id, 'voucher', left('שובר: ' || btrim(new.name), 40), 80)
      returning id into pm;
    new.payment_method_id := pm;
    new.balance := new.initial_amount;
  else
    new.balance := new.initial_amount - coalesce((select sum(u.amount) from public.voucher_uses u where u.voucher_id = new.id), 0);
    update public.payment_methods set label = left('שובר: ' || btrim(new.name), 40), active = not new.archived
     where id = new.payment_method_id and household_id = new.household_id;
  end if;
  return new;
end $$;
create trigger vouchers_before before insert or update on public.vouchers
  for each row execute function public.vouchers_before();
create function public.vouchers_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.payment_methods where id = old.payment_method_id and household_id = old.household_id and type = 'voucher';
  return null;
end $$;
create trigger vouchers_after_delete after delete on public.vouchers
  for each row execute function public.vouchers_after_delete();

-- a saved expense paid with a voucher's method = one use, kept in sync
create function public.transactions_voucher_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  select id into v from public.vouchers
   where household_id = new.household_id and payment_method_id = new.payment_method_id;
  if v is null or new.status <> 'saved' then
    delete from public.voucher_uses where transaction_id = new.id;
    return null;
  end if;
  insert into public.voucher_uses (household_id, voucher_id, transaction_id, amount, date, note, created_by)
  values (new.household_id, v, new.id, new.amount, new.date, left(new.merchant, 120), new.created_by)
  on conflict (transaction_id) do update set voucher_id = excluded.voucher_id, amount = excluded.amount,
    date = excluded.date, note = excluded.note;
  return null;
end $$;
-- (a deleted transaction takes its use with it: FK on delete cascade)
create trigger transactions_voucher_sync after insert or update of payment_method_id, amount, date, status, merchant
  on public.transactions for each row execute function public.transactions_voucher_sync();

-- Same as 0013 + voucher expiry reminders (30 / 7 / 1 days, once per window, only with a balance).
create or replace function public.svc_due_notifications(p_now timestamptz default now())
returns table (queue_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, title text, body text, url text, tag text)
language plpgsql security definer set search_path = '' as $$
declare
  m record; pr public.notification_prefs; loc timestamp; wk numeric; mo numeric; f record; a record;
  due date; today date; st smallint; v record; d int; win int;
begin
  for m in select distinct hm.user_id, hm.household_id from public.household_members hm
           where exists (select 1 from public.push_subscriptions s where s.user_id = hm.user_id) loop
    pr := public.prefs_of(m.user_id);
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
    if pr.bills then
      for v in select id, name, balance, expires_on from public.vouchers
               where household_id = m.household_id and not archived and balance > 0 and expires_on is not null loop
        d := v.expires_on - today;
        win := case when d < 0 or d > 30 then null when d <= 1 then 1 when d <= 7 then 7 else 30 end;
        if win is not null then
          insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
          values (m.user_id, m.household_id, 'voucher', 'שובר עומד לפוג: ' || left(v.name, 40),
                  case when d = 0 then 'היום' when d = 1 then 'מחר' else 'בעוד ' || d::text || ' ימים' end
                    || ' · יתרה ' || round(v.balance)::text || ' ₪.', './#/plan',
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
