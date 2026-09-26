-- ============================================================================
-- 0006_phase2.sql — budgets (+80/100% alerts), Web Push, receipt line items
-- (price history), annual expenses calendar, savings goals, fixed-expense
-- suggestion dismissals. Same model as Phase 1: RLS default deny, members read,
-- owners/members write, restrictive aal2 gate on household data.
-- ============================================================================

-- ---------------------------------------------------------------- budgets
create table public.budgets (
  household_id  uuid not null references public.households (id) on delete cascade,
  category      text not null check (char_length(category) between 1 and 40),
  amount        numeric(12,2) not null check (amount > 0),
  updated_at    timestamptz not null default now(),
  primary key (household_id, category)
);

-- one row per (category, month, level) that fired — dedupes the push alert
create table public.budget_alerts (
  household_id  uuid not null references public.households (id) on delete cascade,
  category      text not null,
  month         text not null,
  level         smallint not null check (level in (80, 100)),
  created_at    timestamptz not null default now(),
  primary key (household_id, category, month, level)
);

-- ------------------------------------------------------ price history
create table public.receipt_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  transaction_id  uuid not null,
  name            text not null check (char_length(name) between 1 and 80),
  norm_name       text not null check (char_length(norm_name) <= 80),
  qty             numeric(10,3) not null default 1,
  unit_price      numeric(12,2) null,
  total           numeric(12,2) null,
  store           text not null default '' check (char_length(store) <= 80),
  date            date not null,
  created_at      timestamptz not null default now(),
  foreign key (household_id, transaction_id) references public.transactions (household_id, id) on delete cascade
);
create index receipt_items_name_idx on public.receipt_items (household_id, norm_name);

-- ------------------------------------------------- annual expenses
create table public.annual_expenses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  amount        numeric(12,2) not null check (amount >= 0),
  due_month     smallint not null check (due_month between 1 and 12),
  due_day       smallint not null default 1 check (due_day between 1 and 31),
  category      text not null default 'שונות' check (char_length(category) between 1 and 40),
  person_id     uuid null,
  remind_days   smallint not null default 14 check (remind_days between 0 and 90),
  note          text not null default '' check (char_length(note) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (household_id, person_id) references public.people (household_id, id) on delete set null (person_id)
);

-- --------------------------------------------------- savings goals
create table public.savings_goals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  target        numeric(12,2) not null check (target > 0),
  target_date   date null,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (household_id, id)
);

create table public.goal_deposits (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  goal_id       uuid not null,
  amount        numeric(12,2) not null check (amount <> 0),
  date          date not null default current_date,
  note          text not null default '' check (char_length(note) <= 100),
  created_by    uuid null default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (household_id, goal_id) references public.savings_goals (household_id, id) on delete cascade
);

-- ------------------------------------- fixed-expense suggestions
create table public.suggestion_dismissals (
  household_id  uuid not null references public.households (id) on delete cascade,
  key           text not null check (char_length(key) <= 120),
  created_at    timestamptz not null default now(),
  primary key (household_id, key)
);

-- ------------------------------------------------------ notifications
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) between 20 and 200),
  auth        text not null check (char_length(auth) between 8 and 100),
  user_agent  text not null default '' check (char_length(user_agent) <= 200),
  fail_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz null
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.notification_prefs (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  weekly_summary  boolean not null default true,
  bills           boolean not null default true,
  receipts        boolean not null default true,
  budget          boolean not null default true,
  weekly_day      smallint not null default 0 check (weekly_day between 0 and 6),
  quiet_start     smallint not null default 22 check (quiet_start between 0 and 23),
  quiet_end       smallint not null default 7 check (quiet_end between 0 and 23),
  tz              text not null default 'Asia/Jerusalem' check (char_length(tz) <= 60),
  updated_at      timestamptz not null default now()
);

create table public.notification_queue (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  household_id  uuid null references public.households (id) on delete cascade,
  kind          text not null check (kind in ('receipts', 'budget', 'bill', 'annual', 'weekly', 'test')),
  title         text not null check (char_length(title) <= 80),
  body          text not null check (char_length(body) <= 240),
  url           text not null default './#/overview' check (char_length(url) <= 200),
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz null,
  unique (user_id, kind, dedupe_key)
);
create index notification_queue_unsent_idx on public.notification_queue (created_at) where sent_at is null;

-- ------------------------------------------------------------ triggers
create trigger annual_touch before update on public.annual_expenses
  for each row execute function public.touch_updated_at();
create trigger goals_touch before update on public.savings_goals
  for each row execute function public.touch_updated_at();

-- prefs of a user, with defaults when they never saved any
create function public.prefs_of(p_user uuid) returns public.notification_prefs
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p from public.notification_prefs p where p.user_id = p_user),
    row(p_user, true, true, true, true, 0::smallint, 22::smallint, 7::smallint, 'Asia/Jerusalem', now())::public.notification_prefs)
$$;

-- enqueue one notification for every member of a household who wants this kind
create function public.enqueue_household(
  p_household uuid, p_kind text, p_title text, p_body text, p_url text, p_key text, p_writers_only boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare m record; pr public.notification_prefs;
begin
  for m in select user_id, role from public.household_members where household_id = p_household loop
    if p_writers_only and m.role = 'viewer' then continue; end if;
    pr := public.prefs_of(m.user_id);
    if (p_kind = 'budget' and not pr.budget) or (p_kind = 'receipts' and not pr.receipts)
       or (p_kind in ('bill', 'annual') and not pr.bills) or (p_kind = 'weekly' and not pr.weekly_summary) then
      continue;
    end if;
    insert into public.notification_queue (user_id, household_id, kind, title, body, url, dedupe_key)
    values (m.user_id, p_household, p_kind, left(p_title, 80), left(p_body, 240), p_url, p_key)
    on conflict (user_id, kind, dedupe_key) do nothing;
  end loop;
end $$;

-- Budget alerts at 80% and 100% (once per category / month / level).
create function public.budget_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b numeric; spent numeric; lvl smallint; inserted int;
begin
  if new.status <> 'saved' then return new; end if;
  select amount into b from public.budgets where household_id = new.household_id and category = new.category;
  if b is null then return new; end if;
  select coalesce(sum(amount), 0) into spent from public.transactions
   where household_id = new.household_id and month = new.month and category = new.category and status = 'saved';
  lvl := case when spent >= b then 100 when spent >= b * 0.8 then 80 else null end;
  if lvl is null then return new; end if;
  insert into public.budget_alerts (household_id, category, month, level) values (new.household_id, new.category, new.month, lvl)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    perform public.enqueue_household(new.household_id, 'budget',
      case when lvl = 100 then 'עברתם את התקציב' else 'קרוב לתקציב' end,
      new.category || ': ' || round(spent)::text || ' ₪ מתוך ' || round(b)::text || ' ₪ (' || round(spent / b * 100)::text || '%)',
      './#/plan', new.category || ':' || new.month || ':' || lvl);
  end if;
  return new;
end $$;
create trigger transactions_budget after insert or update of amount, category, month, status on public.transactions
  for each row execute function public.budget_check();

-- "X receipts ready for approval" when a batch finishes.
create function public.receipts_ready() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if old.status = 'submitted' and new.status = 'ended' then
    select count(*) into n from jsonb_array_elements(new.items) e where e->>'status' = 'parsed';
    if n > 0 then
      perform public.enqueue_household(new.household_id, 'receipts',
        case when n = 1 then 'קבלה אחת מחכה לאישור' else n::text || ' קבלות מחכות לאישור' end,
        'Claude קרא את הקבלות. אפשר לבדוק ולאשר.', './#/tx', new.id::text, true);
    end if;
  end if;
  return new;
end $$;
create trigger receipt_jobs_ready after update of status on public.receipt_jobs
  for each row execute function public.receipts_ready();

-- Receipt line items → price history (replaces the Phase 1 no-op hook).
create or replace function public.svc_after_receipt_tx(p_household uuid, p_tx uuid, p_receipt jsonb, p_date date)
returns void language plpgsql security definer set search_path = '' as $$
declare it jsonb; v_name text; v_store text := left(coalesce(p_receipt->>'merchant', ''), 80);
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
end $$;

create function public.norm_item(p text) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(lower(regexp_replace(coalesce(p, ''), '["''׳״.,()*/\\-]', ' ', 'g')), '\s+', ' ', 'g')), 80)
$$;

-- ------------------------------------------------ scheduled notifications
-- Adds weekly summaries and bill/annual reminders that are due, then returns
-- unsent notifications for users who are not in their quiet hours, joined
-- with their push subscriptions. Called by the notify Edge Function (cron).
create function public.svc_due_notifications(p_now timestamptz default now())
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
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות');
      select coalesce(sum(amount), 0) into mo from public.transactions
       where household_id = m.household_id and status = 'saved' and month = to_char(loc, 'YYYY-MM')
         and category not in ('הכנסה', 'חיוב אשראי מרוכז', 'העברה בין חשבונות');
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

create function public.svc_mark_sent(p_queue uuid[], p_ok_subs uuid[], p_dead_subs uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_queue set sent_at = now() where id = any (p_queue);
  update public.push_subscriptions set last_ok_at = now(), fail_count = 0 where id = any (p_ok_subs);
  delete from public.push_subscriptions where id = any (p_dead_subs);
end $$;

create function public.svc_user_subscriptions(p_user uuid)
returns table (subscription_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = '' as $$
  select id, endpoint, p256dh, auth from public.push_subscriptions where user_id = p_user
$$;

-- ------------------------------------------------------------------- RLS
alter table public.budgets               enable row level security;
alter table public.budget_alerts         enable row level security;
alter table public.receipt_items         enable row level security;
alter table public.annual_expenses       enable row level security;
alter table public.savings_goals         enable row level security;
alter table public.goal_deposits         enable row level security;
alter table public.suggestion_dismissals enable row level security;
alter table public.push_subscriptions    enable row level security;
alter table public.notification_prefs    enable row level security;
alter table public.notification_queue    enable row level security;   -- no policies: service only

-- household tables: members read, owners/members write, aal2 gate
do $$
declare t text;
begin
  foreach t in array array['budgets', 'annual_expenses', 'savings_goals', 'goal_deposits', 'suggestion_dismissals', 'receipt_items', 'budget_alerts'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.is_member(household_id))', t);
    execute format('create policy mfa_gate on public.%1$s as restrictive for all to authenticated using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id))', t);
  end loop;
  foreach t in array array['budgets', 'annual_expenses', 'savings_goals', 'suggestion_dismissals'] loop
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_write(household_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_write(household_id)) with check (public.can_write(household_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.can_write(household_id))', t);
  end loop;
end $$;
create policy goal_deposits_insert on public.goal_deposits for insert to authenticated
  with check (public.can_write(household_id) and created_by = (select auth.uid()));
create policy goal_deposits_delete on public.goal_deposits for delete to authenticated using (public.can_write(household_id));
create policy receipt_items_delete on public.receipt_items for delete to authenticated using (public.can_write(household_id));

-- personal tables: only your own rows. A push subscription carries amounts in
-- notifications, so creating one needs the second factor when you have one.
create policy push_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create function public.personal_mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2' or not public.has_verified_factor((select auth.uid()))
$$;
create policy push_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and public.personal_mfa_ok());
create policy push_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
create policy prefs_select on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));
create policy prefs_insert on public.notification_prefs for insert to authenticated with check (user_id = (select auth.uid()));
create policy prefs_update on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- grants
revoke all on public.budgets, public.budget_alerts, public.receipt_items, public.annual_expenses, public.savings_goals,
  public.goal_deposits, public.suggestion_dismissals, public.push_subscriptions, public.notification_prefs,
  public.notification_queue from anon, authenticated;
grant select, insert, update, delete on public.budgets, public.annual_expenses, public.savings_goals, public.suggestion_dismissals to authenticated;
grant select on public.budget_alerts to authenticated;
grant select, delete on public.receipt_items to authenticated;
grant select, insert, delete on public.goal_deposits to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant select, insert, update on public.notification_prefs to authenticated;
grant all on all tables in schema public to service_role;
revoke execute on function public.personal_mfa_ok() from public, anon;
grant execute on function public.personal_mfa_ok() to authenticated;

revoke execute on function public.prefs_of(uuid), public.enqueue_household(uuid, text, text, text, text, text, boolean),
  public.budget_check(), public.receipts_ready(), public.norm_item(text), public.svc_due_notifications(timestamptz),
  public.svc_mark_sent(uuid[], uuid[], uuid[]), public.svc_user_subscriptions(uuid)
from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
