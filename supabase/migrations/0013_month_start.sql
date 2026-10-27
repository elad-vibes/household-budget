-- 0013: budget month start (next-features.md §3). A household can start its month on
-- day 1–28. The stored transactions.month is NOT changed (it stays the calendar /
-- statement month); the budget month is DERIVED by public.budget_month(), the same rule
-- as src/domain/month.ts (DECISIONS #37). With start day 1 every number is unchanged.

alter table public.household_settings
  add column month_start_day smallint not null default 1 check (month_start_day between 1 and 28);
grant update (month_start_day) on public.household_settings to authenticated;

-- start 1, or a row whose stored month differs from its date's month (installment /
-- moved by the statement) → the stored month; otherwise day ≥ start ? month : month before.
create function public.budget_month(p_date date, p_month text, p_start smallint) returns text
language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_start, 1) <= 1 or to_char(p_date, 'YYYY-MM') <> p_month then p_month
    when extract(day from p_date) >= p_start then p_month
    else to_char(to_date(p_month || '-01', 'YYYY-MM-DD') - interval '1 month', 'YYYY-MM')
  end
$$;

create function public.month_start_of(p_household uuid) returns smallint
language sql stable security definer set search_path = '' as $$
  select coalesce((select month_start_day from public.household_settings where household_id = p_household), 1)::smallint
$$;
revoke all on function public.month_start_of(uuid) from public, anon, authenticated;

-- Budget alerts at 80% and 100%, per BUDGET month (was: stored month).
create or replace function public.budget_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b numeric; spent numeric; lvl smallint; inserted int; st smallint; bm text;
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
    perform public.enqueue_household(new.household_id, 'budget',
      case when lvl = 100 then 'עברתם את התקציב' else 'קרוב לתקציב' end,
      new.category || ': ' || round(spent)::text || ' ₪ מתוך ' || round(b)::text || ' ₪ (' || round(spent / b * 100)::text || '%)',
      './#/plan', new.category || ':' || bm || ':' || lvl);
  end if;
  return new;
end $$;
-- the date now matters too (with start > 1 it can move a row to another budget month)
drop trigger transactions_budget on public.transactions;
create trigger transactions_budget after insert or update of amount, category, month, date, status on public.transactions
  for each row execute function public.budget_check();

-- Weekly summary: "מתחילת החודש" = since the start of the BUDGET month. Otherwise identical to 0008.
create or replace function public.svc_due_notifications(p_now timestamptz default now())
returns table (queue_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, title text, body text, url text, tag text)
language plpgsql security definer set search_path = '' as $$
declare
  m record; pr public.notification_prefs; loc timestamp; wk numeric; mo numeric; f record; a record;
  due date; today date; st smallint;
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
