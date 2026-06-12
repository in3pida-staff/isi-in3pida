import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

      const geminiKey = Deno.env.get('GEMINI_API_KEY') || (site.hotel_profile as any)?.isi_config?.gemini_api_key || ''
      if (!geminiKey) return new Response(JSON.stringify({ error: 'Chiave API Gemini non configurata. Vai in Impostazioni → Chiavi API.' }), { status: 422, headers: cors })

      const ar = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Sei l'assistente virtuale di un hotel italiano. Rispondi in italiano in modo diretto e professionale (2-4 frasi). Usa SOLO le informazioni fornite. Non inventare nulla.\n\nInformazioni hotel:\n${lines}\n\nDomanda del cliente: ${query}\n\nRisposta:` }] }],
            generationConfig: { maxOutputTokens: 400 }
          })
        }
      )
      const ad = await ar.json()
      const answer = ad.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
      if (!answer) return new Response(JSON.stringify({ error: 'empty_response', detail: ad.error?.message || '' }), { status: 500, headers: cors })
      return new Response(JSON.stringify({ answer }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ─── PSE QUERY (original) ────────────────────────────────────────────────
    if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase.from('isi_sites').select('pse_enabled, site_name, hotel_profile').eq('site_id', site_id).single()
    if (!site?.pse_enabled) return new Response(JSON.stringify({ error: 'PSE not enabled' }), { status: 403, headers: cors })

    const geminiKeyPse = Deno.env.get('GEMINI_API_KEY') || (site.hotel_profile as any)?.isi_config?.gemini_api_key || ''
    if (!geminiKeyPse) return new Response(JSON.stringify({ error: 'Chiave API Gemini non configurata' }), { status: 422, headers: cors })

    const prompt = `Sei un consulente GEO (Generative Engine Optimization) specializzato in strutture ricettive italiane.
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
}

Profilo hotel:
${JSON.stringify(body.hotel_context, null, 2)}

Query utente: "${query}"`

    const geminiRes2 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKeyPse}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 800 }
        })
      }
    )

    const geminiData2 = await geminiRes2.json()
    const rawText = geminiData2.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    let result: any = {}
    try { result = JSON.parse(rawText) } catch { result = { error: 'Parse error', raw: rawText } }

    const tokensIn = geminiData2.usageMetadata?.promptTokenCount ?? 0
    const tokensOut = geminiData2.usageMetadata?.candidatesTokenCount ?? 0
    const costUsd = tokensIn * 0.000000075 + tokensOut * 0.0000003

    await supabase.from('isi_pse_queries').insert({
      site_id, site_name: site.site_name, query,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
      model: 'gemini-2.0-flash', result
    })

    return new Response(JSON.stringify({ ok: true, result, cost_usd: costUsd }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
