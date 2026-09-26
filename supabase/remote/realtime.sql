-- Supabase-only: publish tables to Realtime (RLS still applies per subscriber).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'shopping_items') then
    alter publication supabase_realtime add table public.shopping_items;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
end $$;
