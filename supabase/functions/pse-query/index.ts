import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

async function groq(systemPrompt: string, userPrompt: string, maxTokens = 400, temperature = 0.7): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  })
  const d = await res.json()
  return d.choices?.[0]?.message?.content?.trim() ?? ''
}

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
        sc.address?.addressLocality || hp.citta || hp.localita ? `Città: ${sc.address?.addressLocality || hp.citta || hp.localita}` : '',
        sc.telephone || hp.telefono ? `Telefono: ${sc.telephone || hp.telefono}` : '',
        sc.email     || hp.email    ? `Email: ${sc.email || hp.email}` : '',
        sc.checkinTime  || hp.check_in  ? `Check-in: ${sc.checkinTime || hp.check_in}` : '',
        sc.checkoutTime || hp.check_out ? `Check-out: ${sc.checkoutTime || hp.check_out}` : '',
        sc.description  || hp.descrizione ? `Descrizione: ${sc.description || hp.descrizione}` : '',
        (sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi) ? `Servizi: ${sc.amenityFeature?.map((a: any) => a.name || a).join(', ') || hp.servizi}` : '',
      ].filter(Boolean).join('\n')

      if (!lines.trim()) return new Response(JSON.stringify({ error: 'no_data' }), { status: 422, headers: cors })
      if (!GROQ_API_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY non configurata' }), { status: 422, headers: cors })

      const raw = await groq(
        `Sei un redattore di FAQ per siti di hotel italiani. Rispondi SOLO con JSON valido, nessun testo extra.

REGOLE FONDAMENTALI:
1. Rispondi sempre in italiano, tono commerciale positivo, 2-4 frasi.
2. Usa SOLO i fatti presenti nei dati forniti. Non inventare prezzi, orari, servizi specifici non menzionati.
3. Se la domanda è generica o abbinabile a qualcosa nei dati, rispondi con quello che sai — imposta "sufficient": true.
4. Imposta "sufficient": false SOLO se la domanda richiede un fatto specifico (es. prezzo esatto, orario preciso, servizio concreto) che NON è nei dati e sarebbe impossibile rispondere senza inventarlo.
5. Non usare MAI: "mi dispiace", "non sono in grado", "non ho informazioni", "non posso".
6. Puoi suggerire di contattare la reception per dettagli molto specifici, ma solo come frase finale — non come unica risposta.

Formato risposta:
{"answer":"<risposta in italiano>","sufficient":<true|false>}`,
        `Dati hotel:\n${lines}\n\nDomanda FAQ: "${query}"\n\nRispondi con JSON:`,
        500,
        0.3
      )

      let parsed: { answer?: string; sufficient?: boolean } = {}
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
      } catch { parsed = {} }

      if (!parsed.answer) return new Response(JSON.stringify({ error: 'empty_response' }), { status: 500, headers: cors })
      return new Response(
        JSON.stringify({ answer: parsed.answer, sufficient: parsed.sufficient !== false }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    // ─── PSE QUERY ────────────────────────────────────────────────────────────
    if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase.from('isi_sites').select('pse_enabled, site_name, hotel_profile').eq('site_id', site_id).single()
    if (!site?.pse_enabled) return new Response(JSON.stringify({ error: 'PSE not enabled' }), { status: 403, headers: cors })
    if (!GROQ_API_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY non configurata' }), { status: 422, headers: cors })

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

    const rawText = await groq(systemPrompt, `Profilo hotel:\n${JSON.stringify(body.hotel_context, null, 2)}\n\nQuery utente: "${query}"`, 800)
    let result: any = {}
    try { result = JSON.parse(rawText) } catch { result = { error: 'Parse error', raw: rawText } }

    await supabase.from('isi_pse_queries').insert({
      site_id, site_name: site.site_name, query,
      tokens_in: 0, tokens_out: 0, cost_usd: 0,
      model: 'llama-3.1-8b-instant', result
    })

    return new Response(JSON.stringify({ ok: true, result, cost_usd: 0 }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
