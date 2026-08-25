import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { reportAiStatus } from '../_shared/alerts.ts'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const GROQ_API_KEY     = Deno.env.get('GROQ_API_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { site_id, queries } = await req.json()
    // queries: [{query: string, cat: string}]
    if (!site_id || !queries?.length)
      return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Verifica ruolo utente dal JWT — admin bypass rate limit
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace('Bearer ', '')
    let isAdmin = false
    if (jwt) {
      const { data: { user } } = await supabase.auth.getUser(jwt)
      isAdmin = user?.user_metadata?.role !== 'albergatore'
    }

    // Rate limit: 1 volta a settimana, solo per albergatori
    const { data: site } = await supabase
      .from('isi_sites')
      .select('hotel_profile, schema_data, site_name, last_reason_gap_at')
      .eq('site_id', site_id)
      .single()

    if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

    if (!GROQ_API_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY non configurata' }), { status: 422, headers: cors })

    const now = new Date()

    if (!isAdmin) {
      const lastRun = site.last_reason_gap_at ? new Date(site.last_reason_gap_at) : null
      const daysSince = lastRun ? (now.getTime() - lastRun.getTime()) / 86400000 : 999
      if (daysSince < 7)
        return new Response(JSON.stringify({ error: 'rate_limit', next_allowed_at: new Date(lastRun!.getTime() + 7 * 86400000).toISOString() }), { status: 429, headers: cors })
    }

    // Costruisci profilo hotel
    const hp = site.hotel_profile || {}
    const sc = site.schema_data   || {}
    const profileLines = [
      sc.name || hp.nome_hotel || hp.nome || site.site_name ? `Nome: ${sc.name || hp.nome_hotel || hp.nome || site.site_name}` : '',
      sc.description || hp.descrizione ? `Descrizione: ${sc.description || hp.descrizione}` : '',
      sc.starRating?.ratingValue || hp.stelle ? `Stelle: ${sc.starRating?.ratingValue || hp.stelle}` : '',
      sc.address?.addressLocality || hp.citta ? `Città: ${sc.address?.addressLocality || hp.citta}` : '',
      sc.checkinTime  || hp.check_in  ? `Check-in: ${sc.checkinTime || hp.check_in}` : '',
      sc.checkoutTime || hp.check_out ? `Check-out: ${sc.checkoutTime || hp.check_out}` : '',
      (sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi) ? `Servizi: ${sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi}` : '',
      hp.parcheggio ? `Parcheggio: ${hp.parcheggio}` : '',
      hp.animali ? `Animali: ${hp.animali}` : '',
      hp.colazione ? `Colazione: ${hp.colazione}` : '',
    ].filter(Boolean).join('\n')

    const queryList = queries.map((q: any, i: number) => `${i + 1}. "${q.query}" (categoria: ${q.cat})`).join('\n')

    const prompt = `Sei un esperto di ottimizzazione per motori AI (GEO) per hotel italiani.

Profilo hotel:
${profileLines}

L'hotel NON appare nelle risposte AI per queste ricerche:
${queryList}

Per ciascuna ricerca, indica in modo semplice (max 2 righe) cosa manca nel profilo dell'hotel per apparire. Rispondi SOLO con JSON valido:
[
  {"query": "testo query", "cat": "categoria", "gaps": ["cosa manca 1", "cosa manca 2"]},
  ...
]`

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        max_tokens: 4000,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Sei un esperto GEO per hotel italiani. Rispondi SOLO con JSON valido, nessun testo extra prima o dopo il JSON.' },
          { role: 'user', content: prompt }
        ]
      })
    })

    await reportAiStatus(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'reason:gap', groqRes.ok, 'Analisi Query Mancanti (Reason Gap)', { source: 'reason-gap', model: 'openai/gpt-oss-20b' })
    const groqData = await groqRes.json()
    const rawText = groqData.choices?.[0]?.message?.content?.trim() ?? '[]'

    let results: any[] = []
    try { results = JSON.parse(rawText) } catch { results = [] }

    const costUsd = 0

    // Salva risultati
    if (results.length) {
      await supabase.from('isi_reason_gap_results').insert(
        results.map((r: any) => ({
          site_id,
          site_name: site.site_name,
          query: r.query,
          cat: r.cat,
          gaps: r.gaps,
          model: 'openai/gpt-oss-20b',
          cost_usd: costUsd / results.length,
          created_at: now.toISOString()
        }))
      )
    }

    // Aggiorna timestamp ultimo run
    await supabase.from('isi_sites').update({ last_reason_gap_at: now.toISOString() }).eq('site_id', site_id)

    return new Response(JSON.stringify({ ok: true, results, cost_usd: costUsd }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    try { await reportAiStatus(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'reason:gap', false, 'Analisi Query Mancanti (Reason Gap)', { source: 'reason-gap', model: 'openai/gpt-oss-20b' }) } catch (_) {}
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
