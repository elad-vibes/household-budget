-- Supabase-only: scheduled Edge Function calls (pg_cron + pg_net). The project
-- URL and the cron secret live in Vault (set by scripts/setup-remote.mjs).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname in ('hb-poll-batches', 'hb-notify', 'hb-cleanup');

-- receipt batches → review transactions (every 30 minutes)
select cron.schedule('hb-poll-batches', '*/30 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'hb_project_url') || '/functions/v1/poll-batches',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hb_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000)
$job$);

-- Web Push (weekly summary, bills, annual, receipts ready, budget alerts)
select cron.schedule('hb-notify', '5,35 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'hb_project_url') || '/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hb_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$job$);

-- housekeeping
select cron.schedule('hb-cleanup', '17 3 * * *', $job$
  delete from public.rate_limits where window_start < now() - interval '2 days';
  delete from public.notification_queue where sent_at < now() - interval '30 days';
$job$);
