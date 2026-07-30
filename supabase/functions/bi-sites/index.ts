// API read-only per in3pida BI — elenco siti gestiti da Eletta
// Auth: header X-Eletta-Key === BI_API_KEY (altrimenti 401). Nessun dato personale.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const BI_API_KEY   = Deno.env.get('BI_API_KEY') ?? ''

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return (url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') }
}

Deno.serve(async (req) => {
  const key = req.headers.get('x-eletta-key') || ''
  if (!BI_API_KEY || key !== BI_API_KEY) return json({ error: 'unauthorized' }, 401)

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/isi_sites?select=site_id,site_name,site_url&order=site_name.asc`,
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } },
  )
  const rows = await r.json().catch(() => [])
  const out = (Array.isArray(rows) ? rows : []).map((s: any) => ({
    id: s.site_id,
    nome: s.site_name || '',
    dominio: domainOf(s.site_url || ''),
  }))
  return json(out)
})
