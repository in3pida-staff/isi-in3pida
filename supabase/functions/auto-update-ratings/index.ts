// Aggiornamento automatico rating portali per tutti gli hotel
// Viene chiamato settimanalmente da pg_cron

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SELF_URL             = SUPABASE_URL + '/functions/v1/fetch-rating'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

async function fetchRating(url: string, source: string): Promise<{ rating: string | null; n_recensioni: string | null }> {
  try {
    const res = await fetch(SELF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ url, source }),
      signal: AbortSignal.timeout(35000),
    })
    const data = await res.json()
    return { rating: data.rating ?? null, n_recensioni: data.n_recensioni ?? null }
  } catch { return { rating: null, n_recensioni: null } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    // Legge tutti i siti con URL portali compilati
    const sitesRes = await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?select=site_id,hotel_profile`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    })
    const sites = await sitesRes.json()

    let updated = 0, skipped = 0

    for (const site of sites) {
      const hp = site.hotel_profile || {}
      const taUrl  = hp.tripadvisor_url || ''
      const gUrl   = hp.google_business_url || ''
      const bkUrl  = hp.url_recensioni || ''

      if (!taUrl && !gUrl && !bkUrl) { skipped++; continue }

      const patch: Record<string, string> = {}

      if (taUrl) {
        const r = await fetchRating(taUrl, 'tripadvisor')
        if (r.rating)       patch.tripadvisor_rating       = r.rating
        if (r.n_recensioni) patch.tripadvisor_n_recensioni = r.n_recensioni
      }
      if (gUrl) {
        const r = await fetchRating(gUrl, 'google')
        if (r.rating)       patch.google_rating       = r.rating
        if (r.n_recensioni) patch.google_n_recensioni = r.n_recensioni
      }
      if (bkUrl) {
        const r = await fetchRating(bkUrl, 'booking')
        if (r.rating)       patch.booking_rating       = r.rating
        if (r.n_recensioni) patch.booking_n_recensioni = r.n_recensioni
      }

      // Salva sempre il timestamp dell'ultimo controllo
      patch.ratings_last_check = new Date().toISOString()

      // Aggiorna hotel_profile con i nuovi valori
      const current = { ...hp, ...patch }
      await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${site.site_id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ hotel_profile: current }),
      })
      updated++
    }

    return new Response(JSON.stringify({ ok: true, updated, skipped, total: sites.length }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
