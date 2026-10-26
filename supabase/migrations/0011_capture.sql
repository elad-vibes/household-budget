-- ============================================================================
-- 0011_capture.sql — automatic capture from iPhone Shortcuts (next-features.md §2).
--   * capture_tokens: one random token per user+household, shown ONCE, stored as
--     sha256; revocable / rotatable. A token can only add expenses for its own user
--     in its own household, and only while that user may still write there.
--   * transactions.source gains 'wallet' (Apple Pay automation) and 'quick' (Back Tap).
--   * svc_capture: validation, 2-minute dedup, payment method by card/pass name,
--     match_status so the statement import merges a wallet row (no double count).
-- ============================================================================

create table public.capture_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  token_hash    text not null unique,
  label         text not null default '' check (char_length(label) <= 40),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz null,
  revoked_at    timestamptz null
);
create index capture_tokens_user_idx on public.capture_tokens (user_id, household_id);
alter table public.capture_tokens enable row level security;
create policy capture_tokens_select on public.capture_tokens for select to authenticated
  using (user_id = (select auth.uid()) and public.is_member(household_id));
create policy mfa_gate on public.capture_tokens as restrictive for all to authenticated
  using (public.mfa_ok(household_id)) with check (public.mfa_ok(household_id));
revoke all on public.capture_tokens from anon, authenticated;
grant select (id, household_id, label, created_at, last_used_at, revoked_at) on public.capture_tokens to authenticated;
grant all on public.capture_tokens to service_role;

alter table public.transactions drop constraint transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('manual', 'import', 'statement', 'receipt', 'backup', 'wallet', 'quick'));

-- New token (revokes the caller's previous ones in this household = rotation). Returns the token ONCE.
create function public.create_capture_token(p_household uuid, p_label text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if auth.uid() is null or not public.can_write(p_household) or not public.mfa_ok(p_household) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update public.capture_tokens set revoked_at = now()
   where user_id = auth.uid() and household_id = p_household and revoked_at is null;
  v_token := 'hbc_' || public.new_token();
  insert into public.capture_tokens (user_id, household_id, token_hash, label)
  values (auth.uid(), p_household, public.token_hash(v_token), left(btrim(coalesce(p_label, '')), 40));
  return v_token;
end $$;

create function public.revoke_capture_tokens(p_household uuid) returns void
language sql security definer set search_path = '' as $$
  update public.capture_tokens set revoked_at = now()
   where user_id = auth.uid() and household_id = p_household and revoked_at is null
$$;

-- Called by the capture Edge Function (service role). p_category: an already-validated category or null.
create function public.svc_capture(
  p_token text, p_amount numeric, p_merchant text, p_card text, p_kind text, p_category text,
  p_category_known boolean, p_note text, p_date date
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.capture_tokens; v_role public.member_role; v_pm public.payment_methods; v_card text := btrim(coalesce(p_card, ''));
  v_id uuid; v_status text; v_match text; v_merchant text := left(btrim(coalesce(p_merchant, '')), 80);
begin
  select * into t from public.capture_tokens where token_hash = public.token_hash(p_token) and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'bad_token'); end if;
  select role into v_role from public.household_members where household_id = t.household_id and user_id = t.user_id;
  if v_role is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_kind not in ('wallet', 'quick') or p_amount is null or p_amount = 0 or abs(p_amount) > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v_merchant = '' then v_merchant := case when p_kind = 'quick' then 'הוספה מהירה' else 'Apple Pay' end; end if;
  update public.capture_tokens set last_used_at = now() where id = t.id;

  -- the same purchase twice within 2 minutes (automation fired twice) → one row
  if exists (select 1 from public.transactions
              where household_id = t.household_id and source in ('wallet', 'quick') and amount = round(p_amount, 2)
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
  -- wallet rows are reviewed unless the merchant matched a category rule; a quick add is the user's own choice
  v_status := case when p_kind = 'quick' or p_category_known then 'saved' else 'review' end;

  insert into public.transactions (household_id, date, month, merchant, amount, category, note, person_id, source, source_title,
                                   status, created_by, payment_method_id, match_status)
  values (t.household_id, p_date, to_char(p_date, 'YYYY-MM'), v_merchant, round(p_amount, 2), coalesce(p_category, 'שונות'),
          left(coalesce(p_note, ''), 200),
          (select id from public.people where household_id = t.household_id and user_id = t.user_id limit 1),
          p_kind, case when p_kind = 'wallet' then 'Apple Pay (קיצור דרך)' else 'הוספה מהירה (קיצור דרך)' end,
          v_status, t.user_id, v_pm.id, v_match)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'status', v_status, 'method', v_pm.label, 'household_id', t.household_id);
end $$;

-- "מה נקלט ומתי": the last 50 things that came in, any source (members of the household).
create function public.capture_log(p_household uuid) returns table (
  id uuid, created_at timestamptz, source text, merchant text, amount numeric, status text, match_status text, created_by_name text
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.created_at, t.source, t.merchant, t.amount, t.status, t.match_status, coalesce(p.display_name, '')
    from public.transactions t left join public.profiles p on p.user_id = t.created_by
   where t.household_id = p_household and public.is_member(p_household) and public.mfa_ok(p_household)
   order by t.created_at desc limit 50
$$;

revoke execute on function public.create_capture_token(uuid, text), public.revoke_capture_tokens(uuid), public.capture_log(uuid),
  public.svc_capture(text, numeric, text, text, text, text, boolean, text, date) from public, anon, authenticated;
grant execute on function public.create_capture_token(uuid, text), public.revoke_capture_tokens(uuid), public.capture_log(uuid) to authenticated;
grant execute on all functions in schema public to service_role;
