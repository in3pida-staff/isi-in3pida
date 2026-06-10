import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const { site_id, query, action } = body

    // ─── FAQ GENERATION ──────────────────────────────────────────────────────
    if (action === 'faq_generate') {
      if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: site } = await supabase.from('isi_sites').select('hotel_profile,schema_data,site_name').eq('site_id', site_id).single()
      if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

      const hp = site.hotel_profile || {}
      const sc = site.schema_data   || {}
      const lines = [
        sc.name || hp.nome_hotel || hp.nome || site.site_name ? `Hotel: ${sc.name || hp.nome_hotel || hp.nome || site.site_name}` : '',
        sc.starRating?.ratingValue || hp.stelle ? `Stelle: ${sc.starRating?.ratingValue || hp.stelle}` : '',
        sc.address?.streetAddress  || hp.indirizzo ? `Indirizzo: ${sc.address?.streetAddress || hp.indirizzo}` : '',
        sc.telephone || hp.telefono ? `Telefono: ${sc.telephone || hp.telefono}` : '',
        sc.email     || hp.email    ? `Email: ${sc.email || hp.email}` : '',
        sc.checkinTime  || hp.check_in  ? `Check-in: ${sc.checkinTime || hp.check_in}` : '',
        sc.checkoutTime || hp.check_out ? `Check-out: ${sc.checkoutTime || hp.check_out}` : '',
        sc.description  || hp.descrizione ? `Descrizione: ${sc.description || hp.descrizione}` : '',
        (sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi) ? `Servizi: ${sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi}` : '',
      ].filter(Boolean).join('\n')

      if (!lines.trim()) return new Response(JSON.stringify({ error: 'no_data' }), { status: 422, headers: cors })

      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 400,
          system: "Sei l'assistente virtuale di un hotel italiano. Rispondi in italiano in modo diretto e professionale (2-4 frasi). Usa SOLO le informazioni fornite. Non inventare nulla.",
          messages: [{ role: 'user', content: `Informazioni hotel:\n${lines}\n\nDomanda del cliente: ${query}\n\nRisposta:` }]
        })
      })
      const ad = await ar.json()
      const answer = ad.content?.[0]?.text?.trim() ?? ''
      if (!answer) return new Response(JSON.stringify({ error: 'empty_response' }), { status: 500, headers: cors })
      return new Response(JSON.stringify({ answer }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ─── PSE QUERY (original) ────────────────────────────────────────────────
    if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase.from('isi_sites').select('pse_enabled, site_name').eq('site_id', site_id).single()
    if (!site?.pse_enabled) return new Response(JSON.stringify({ error: 'PSE not enabled' }), { status: 403, headers: cors })

    const systemPrompt = `Sei un consulente GEO (Generative Engine Optimization) specializzato in strutture ricettive italiane.
Ricevi il profilo di un hotel e una query utente. Analizza se e come questo hotel verrebbe citato in una risposta AI.
Rispondi SOLO con JSON valido, nessun testo extra:
{
  "probability": <0-100>,
  "verdict": "<Molto probabile|Probabile|Incerto|Improbabile|Molto improbabile>",
  "why": "<perché verrebbe/non verrebbe citato, max 2 righe>",
  "strengths": ["<forza 1>","<forza 2>"],
  "weaknesses": ["<debolezza 1>","<debolezza 2>"],
  "suggestions": ["<suggerimento 1>","<suggerimento 2>","<suggerimento 3>"],
  "sample_answer": "<come un AI risponderebbe citando questo hotel, max 2 righe>"
}`
    const userMessage = `Profilo hotel:\n${JSON.stringify(body.hotel_context, null, 2)}\n\nQuery utente: "${query}"`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] })
    })

    const anthropicData = await anthropicRes.json()
    const rawText = anthropicData.content?.[0]?.text ?? '{}'
    let result: any = {}
    try { result = JSON.parse(rawText) } catch { result = { error: 'Parse error', raw: rawText } }

    const tokensIn = anthropicData.usage?.input_tokens ?? 0
    const tokensOut = anthropicData.usage?.output_tokens ?? 0
    const costUsd = tokensIn * 0.0000008 + tokensOut * 0.000004

    await supabase.from('isi_pse_queries').insert({
      site_id, site_name: site.site_name, query,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
      model: 'claude-haiku-4-5-20251001', result
    })

    return new Response(JSON.stringify({ ok: true, result, cost_usd: costUsd }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
