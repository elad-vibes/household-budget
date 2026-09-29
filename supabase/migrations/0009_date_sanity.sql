-- ============================================================================
-- 0009_date_sanity.sql — bug fix, 2026-09-30 (bugs.md).
--
-- Ten transactions from one "עסקאות אחרונות" (recent-transactions) statement
-- screenshot, uploaded 2026-09-27, were saved dated 2025-06-01…05: the model had
-- no idea what day it was and no year was printed on the screen, so it guessed
-- wrong by 15 months. The prompt fix (prompts.ts, same commit) is the real
-- correction; this migration is the safety net for whatever still slips past
-- it — an implausible date is never silently replaced or silently accepted:
-- the value the model gave is KEPT (so nothing is invented), and the row is
-- flagged `date_uncertain` so it is visible in the app instead of hiding in a
-- correct-looking date. A date so broken it fails to parse at all still needs
-- *some* date to satisfy the column, so only that case falls back to the
-- upload day — flagged the same way.
-- ============================================================================

alter table public.transactions
  add column date_uncertain boolean not null default false;

revoke update on public.transactions from authenticated;  -- re-grant explicitly below (defensive; no-op if already column-scoped)
grant update (date, month, merchant, amount, category, is_fixed, note, person_id, status, date_uncertain)
  on public.transactions to authenticated;
grant update (payment_method_id, match_status, matched_transaction_id) on public.transactions to authenticated;

-- ------------------------------------------------------------ statement import
-- Same behavior as 0008's apply_statement, plus: a row (inserted or merged) more
-- than 2 days in the future or more than 60 days before "now" (apply time, which
-- is when the document was actually read — the review screen is short-lived) is
-- flagged, not altered. security invoker is unchanged: RLS still applies.
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
                                   source, source_title, status, payment_method_id, match_status, date_uncertain)
  select p_household, x.date, x.month, x.merchant, x.amount, x.category, coalesce(x.is_fixed, false), coalesce(x.note, ''),
         x.person_id, x.source, coalesce(x.source_title, ''), 'saved', p_method, 'none',
         x.date > current_date + 2 or x.date < current_date - 60
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(date date, month text, merchant text, amount numeric,
         category text, is_fixed boolean, note text, person_id uuid, source text, source_title text);
  get diagnostics v_ins = row_count;
  update public.transactions t
     set amount = x.amount, date = x.date, month = x.month, match_status = 'matched',
         payment_method_id = coalesce(t.payment_method_id, p_method),
         date_uncertain = (x.date > current_date + 2 or x.date < current_date - 60)
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
-- Same behavior as 0003's svc_complete_receipt_job, except the plausibility
-- check no longer throws away the model's date: it only sets date_uncertain.
-- A date that fails to parse at all still has no value to keep, so (only that
-- case) falls back to the day the receipt was uploaded — and is flagged too.
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
    insert into public.transactions (household_id, date, month, merchant, amount, category, is_fixed, note,
                                     person_id, source, source_title, status, receipt_job_id,
                                     receipt_client_id, created_by, date_uncertain)
    values (j.household_id, v_date, to_char(v_date, 'YYYY-MM'),
            left(coalesce(nullif(btrim(r #>> '{receipt,merchant}'), ''), 'קבלה'), 120),
            v_amount, v_cat, false, left(coalesce(r #>> '{receipt,note}', ''), 200),
            v_person, 'receipt', 'קבלה', 'review', j.id, it->>'client_id', j.submitted_by, v_uncertain)
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
