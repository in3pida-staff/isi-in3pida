// Aggiornamento automatico rating portali per tutti gli hotel
// Viene chiamato settimanalmente da pg_cron

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const FETCH_RATING_URL     = SUPABASE_URL + '/functions/v1/fetch-rating'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

async function fetchRating(
  url: string, source: string,
  hotelName: string, hotelCity: string, hotelSiteUrl: string,
): Promise<{ rating: string | null; n_recensioni: string | null }> {
  try {
    const res = await fetch(FETCH_RATING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ url, source, hotel_name: hotelName, hotel_city: hotelCity, hotel_site_url: hotelSiteUrl }),
      signal: AbortSignal.timeout(35000),
    })
    const data = await res.json()
    return { rating: data.rating ?? null, n_recensioni: data.n_recensioni ?? null }
  } catch { return { rating: null, n_recensioni: null } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const sitesRes = await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?select=site_id,hotel_profile,schema_data,site_name`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    })
    const sites = await sitesRes.json()

    let updated = 0, skipped = 0

    for (const site of sites) {
      const hp = site.hotel_profile || {}
      const sc = site.schema_data   || {}

      const taUrl  = hp.tripadvisor_url     || ''
      const gUrl   = hp.google_business_url || ''
      const bkUrl  = hp.url_recensioni      || ''

      if (!taUrl && !gUrl && !bkUrl) { skipped++; continue }

      const hotelName    = sc.name || hp.nome_hotel || hp.nome || site.site_name || ''
      const hotelCity    = hp.citta || sc.city || ''
      const hotelSiteUrl = hp.sito_web || sc.url || ''

      const [ta, goog, bk] = await Promise.all([
        taUrl ? fetchRating(taUrl, 'tripadvisor', hotelName, hotelCity, hotelSiteUrl) : null,
        gUrl  ? fetchRating(gUrl,  'google',      hotelName, hotelCity, hotelSiteUrl) : null,
        bkUrl ? fetchRating(bkUrl, 'booking',     hotelName, hotelCity, hotelSiteUrl) : null,
      ])

      // Traccia cambiamenti rispetto ai valori salvati
      const changes: { campo: string; da: string | null; a: string }[] = []
      const check = (campo: string, old: string | undefined, neu: string | null): string | undefined => {
        if (neu && neu !== (old || '')) { changes.push({ campo, da: old || null, a: neu }); return neu }
        return old
      }

      const newHp = { ...hp }
      if (ta) {
        newHp.tripadvisor_rating      = check('tripadvisor_rating',      hp.tripadvisor_rating,      ta.rating)      ?? hp.tripadvisor_rating
        newHp.tripadvisor_n_recensioni= check('tripadvisor_n_recensioni', hp.tripadvisor_n_recensioni,ta.n_recensioni) ?? hp.tripadvisor_n_recensioni
      }
      if (goog) {
        newHp.google_rating           = check('google_rating',           hp.google_rating,           goog.rating)      ?? hp.google_rating
        if (goog.n_recensioni)
          newHp.google_n_recensioni   = check('google_n_recensioni',     hp.google_n_recensioni,     goog.n_recensioni) ?? hp.google_n_recensioni
      }
      if (bk) {
        newHp.booking_rating          = check('booking_rating',          hp.booking_rating,          bk.rating)        ?? hp.booking_rating
        newHp.booking_n_recensioni    = check('booking_n_recensioni',    hp.booking_n_recensioni,    bk.n_recensioni)   ?? hp.booking_n_recensioni
      }

      const now = new Date().toISOString()
      newHp.ratings_last_check = now
      newHp.ratings_auto_scan  = { scanned_at: now, changes_detected: changes.length > 0, changes }

      await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${site.site_id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ hotel_profile: newHp }),
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
