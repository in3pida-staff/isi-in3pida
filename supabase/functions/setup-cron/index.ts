// Funzione one-shot: configura pg_cron per aggiornamento settimanale rating
// Da chiamare una volta sola, poi può essere rimossa

import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

Deno.serve(async (req) => {
  // Solo chiamate con la chiave di servizio (server/admin). Blocca pubblico/anon.
  // Richiede la CHIAVE DI SERVIZIO reale (una firma falsa non basta).
  if ((req.headers.get('Authorization')||'').replace('Bearer ','') !== (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '___none___'))
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL non disponibile' }), { status: 500 })

  const pool = new Pool(dbUrl, 1, true)
  const client = await pool.connect()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Abilita le estensioni necessarie
    await client.queryObject(`CREATE EXTENSION IF NOT EXISTS pg_cron`).catch(() => {})
    await client.queryObject(`CREATE EXTENSION IF NOT EXISTS pg_net`).catch(() => {})

    // Rimuove job esistente se presente
    await client.queryObject(`
      SELECT cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'auto-update-ratings'
    `).catch(() => {})

    // Crea il cron settimanale lunedì alle 06:00 UTC
    await client.queryObject(`
      SELECT cron.schedule(
        'auto-update-ratings',
        '0 6 * * 1',
        ${'$'}1
      )
    `, [`
      SELECT net.http_post(
        url := '${supabaseUrl}/functions/v1/auto-update-ratings',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer ${serviceKey}"}'::jsonb,
        body := '{}'::jsonb
      );
    `])

    return new Response(JSON.stringify({ ok: true, message: 'Cron impostato: ogni lunedì alle 06:00 UTC' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  } finally {
    client.release()
    await pool.end()
  }
})
