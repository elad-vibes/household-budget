-- ============================================================================
-- 0005_app.sql — small helpers the app needs.
-- ============================================================================

-- Lets the app know whether to show the admin entry (and to ask for 2FA first).
-- Says nothing about anyone else; admin DATA still requires aal2 (is_super_admin()).
create function public.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
$$;
revoke execute on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;
