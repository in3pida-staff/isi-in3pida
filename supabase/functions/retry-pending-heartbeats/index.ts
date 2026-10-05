const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const MAX_ATTEMPTS         = 5

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // Solo chiamate con la chiave di servizio (cron/server). Blocca pubblico/anon.
  // Richiede la CHIAVE DI SERVIZIO reale (una firma falsa non basta).
  if (!SUPABASE_SERVICE_KEY || (req.headers.get('Authorization')||'').replace('Bearer ','') !== SUPABASE_SERVICE_KEY)
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors })

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/isi_pending_heartbeats?select=*`, { headers: sbHeaders })
    const pending = await res.json()

    if (!Array.isArray(pending) || pending.length === 0) {
      return new Response(JSON.stringify({ ok: true, retried: 0 }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    let succeeded = 0, failed = 0, abandoned = 0

    for (const row of pending) {
      const { id, site_id, site_url, attempts } = row

      if (attempts >= MAX_ATTEMPTS) {
        await fetch(`${SUPABASE_URL}/rest/v1/isi_pending_heartbeats?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders })
        abandoned++
        continue
      }

      let ok = false
      try {
        const r = await fetch(`${site_url}/wp-json/in3pida/v1/force-heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })
        ok = r.ok
      } catch { ok = false }

      if (ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/isi_pending_heartbeats?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders })
        succeeded++
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/isi_pending_heartbeats?id=eq.${id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ attempts: attempts + 1, last_attempt_at: new Date().toISOString() }),
        })
        failed++
      }
    }

    return new Response(JSON.stringify({ ok: true, retried: pending.length, succeeded, failed, abandoned }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
