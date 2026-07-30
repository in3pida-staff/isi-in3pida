// API read-only per in3pida BI — dati di un singolo sito Eletta
// Auth: header X-Eletta-Key === BI_API_KEY (altrimenti 401). Nessun dato personale.
// GET ?id=<ELETTA_ID>&range=<mese|6mesi|sempre>
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const BI_API_KEY   = Deno.env.get('BI_API_KEY') ?? ''

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const labelOf = (v: number | null): string | null =>
  v == null ? null : (v >= 70 ? 'ottimizzato' : v >= 40 ? 'da migliorare' : 'critico')

Deno.serve(async (req) => {
  const key = req.headers.get('x-eletta-key') || ''
  if (!BI_API_KEY || key !== BI_API_KEY) return json({ error: 'unauthorized' }, 401)

  const url = new URL(req.url)
  const id = url.searchParams.get('id') || ''
  const range = url.searchParams.get('range') || 'sempre'
  if (!id) return json({ found: false })

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(id)}&select=site_name,site_url,geo_scores,faq_data`,
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } },
  )
  const rows = await r.json().catch(() => [])
  const site = Array.isArray(rows) ? rows[0] : null
  if (!site) return json({ found: false })

  const g = site.geo_scores || {}
  const f = site.faq_data || {}
  const items = Array.isArray(f.items) ? f.items : []
  const pubblicate = items.filter((i: any) => i.status === 'publish' || i.status === 'published').length
  const geo = g.ai_readiness ?? null

  const days = range === 'mese' ? 30 : range === '6mesi' ? 180 : null
  const cutoff = days ? Date.now() - days * 86400000 : null
  const inRange = (dstr: string) => { if (!cutoff) return true; const t = Date.parse(dstr); return isNaN(t) ? true : t >= cutoff }

  const hist = Array.isArray(f.score_history) ? f.score_history : []
  const panoramica = hist
    .filter((h: any) => inRange(h.date))
    .map((h: any) => ({
      data: h.date,
      geo_score: h.geo ?? h.ai_readiness ?? null,
      faq: h.coverage ?? null,
      completezza_profilo: h.completeness ?? null,
    }))

  // Mappa di ricerca AI: Eletta misura se l'hotel viene CITATO (non una "posizione")
  const mappa: any[] = []
  try {
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/isi_pse_queries?site_id=eq.${encodeURIComponent(id)}&select=query,result,created_at&order=created_at.desc&limit=150`,
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } },
    )
    const prows = await pr.json().catch(() => [])
    const engLabel: Record<string, string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity' }
    for (const row of (Array.isArray(prows) ? prows : [])) {
      if (cutoff && Date.parse(row.created_at) < cutoff) continue
      const llm = row.result?.llm_results || {}
      for (const eng of Object.keys(llm)) {
        mappa.push({
          query: row.query,
          motore: engLabel[eng] || eng,
          citato: !!llm[eng]?.cited,
          probabilita: llm[eng]?.probability ?? null,
        })
      }
    }
  } catch (_) { /* mappa vuota se non disponibile */ }

  return json({
    found: true,
    geo_score: geo != null ? Math.round(geo) : null,
    geo_score_label: labelOf(geo),
    completezza_profilo: g.completeness_score ?? null,
    faq: { totale: f.total ?? items.length, pubblicate, punteggio: g.coverage_pct ?? null },
    panoramica,
    mappa_ricerca: mappa.slice(0, 200),
  })
})
