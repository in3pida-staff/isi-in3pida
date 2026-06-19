-- Abilita pg_cron se non già attivo
create extension if not exists pg_cron;

-- Rimuove job esistente se presente
select cron.unschedule('auto-update-ratings') where exists (
  select 1 from cron.job where jobname = 'auto-update-ratings'
);

-- Cron settimanale: ogni lunedì alle 06:00 UTC
select cron.schedule(
  'auto-update-ratings',
  '0 6 * * 1',
  $$
  select net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/auto-update-ratings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
