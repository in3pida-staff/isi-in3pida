// API read-only per in3pida BI — rating recensioni di un singolo sito Eletta
// Auth: header X-Eletta-Key === BI_API_KEY (altrimenti 401). Nessun dato personale.
// GET ?id=<ELETTA_ID>
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const BI_API_KEY   = Deno.env.get('BI_API_KEY') ?? ''

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const key = req.headers.get('x-eletta-key') || ''
  if (!BI_API_KEY || key !== BI_API_KEY) return json({ error: 'unauthorized' }, 401)

  const url = new URL(req.url)
  const id = url.searchParams.get('id') || ''
  if (!id) return json({ found: false })

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(id)}&select=hotel_profile`,
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } },
  )
  const rows = await r.json().catch(() => [])
  const site = Array.isArray(rows) ? rows[0] : null
  if (!site) return json({ found: false })

  const hp = site.hotel_profile || {}

  return json({
    google_rating:             hp.google_rating             ?? null,
    google_n_recensioni:       hp.google_n_recensioni       ?? null,
    tripadvisor_rating:        hp.tripadvisor_rating        ?? null,
    tripadvisor_n_recensioni:  hp.tripadvisor_n_recensioni  ?? null,
    booking_rating:            hp.booking_rating            ?? null,
    booking_n_recensioni:      hp.booking_n_recensioni      ?? null,
  })
})
