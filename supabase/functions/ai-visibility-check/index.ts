import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_API_KEY       = Deno.env.get('GEMINI_API_KEY') ?? ''
const GEMINI_KEY_BACKUP    = Deno.env.get('GEMINI_KEY') ?? ''
const GROQ_API_KEY         = Deno.env.get('GROQ_API_KEY') ?? ''
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { site_id } = await req.json()
    if (!site_id) return new Response(JSON.stringify({ error: 'Missing site_id' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase
      .from('isi_sites')
      .select('hotel_profile, schema_data, site_name, geo_scores')
      .eq('site_id', site_id)
      .single()

    if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

    const hp  = site.hotel_profile || {}
    const sc  = site.schema_data   || {}
    const geo = site.geo_scores    || {}

    const nomeHotel = sc.name || hp.nome_hotel || hp.nome || site.site_name || ''
    const citta     = sc.city || hp.citta || hp.comune || ''
    const stelle    = sc.official_rating || hp.stelle || ''
    const indirizzo = [sc.street, sc.city, sc.postal_code].filter(Boolean).join(', ')
    const telefono  = hp.telefono || sc.telephone || ''

    if (!nomeHotel) return new Response(JSON.stringify({ error: 'No hotel name' }), { status: 400, headers: cors })

    const prompt = `Sei un motore AI. Senza cercare su internet, rispondi basandoti SOLO sulla tua conoscenza di addestramento.

Conosci l'hotel chiamato "${nomeHotel}"${citta ? ` a ${citta}` : ''}?

Rispondi SOLO con questo JSON valido, nessun testo aggiuntivo:
{
  "conosce": true o false,
  "nome_trovato": "nome esatto come lo conosci, o null",
  "stelle_trovate": numero o null,
  "indirizzo_trovato": "indirizzo come lo conosci, o null",
  "telefono_trovato": "telefono come lo conosci, o null",
  "confidenza": numero da 0 a 100
}`

    const tryGemini = async (key: string): Promise<string | null> => {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            signal: AbortSignal.timeout(15000),
          }
        )
        if (!r.ok) return null
        const d = await r.json()
        return d?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      } catch { return null }
    }

    const tryGroq = async (): Promise<string | null> => {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'user', content: prompt + '\n\nRispondi SOLO con JSON valido.' }],
            max_tokens: 300,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(15000),
        })
        if (!r.ok) return null
        const d = await r.json()
        return d?.choices?.[0]?.message?.content ?? null
      } catch { return null }
    }

    let raw = await tryGemini(GEMINI_API_KEY)
    if (!raw && GEMINI_KEY_BACKUP) raw = await tryGemini(GEMINI_KEY_BACKUP)
    if (!raw) raw = await tryGroq()
    if (!raw) return new Response(JSON.stringify({ error: 'ai_unavailable' }), { status: 503, headers: cors })

    let parsed: Record<string, unknown> | null = null
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : null
    } catch { parsed = null }

    if (!parsed) return new Response(JSON.stringify({ error: 'parse_failed' }), { status: 500, headers: cors })

    // Calcola punteggio AI Visibility
    let score = 0
    if (parsed.conosce) {
      score += 40
      const nomeTrovato = String(parsed.nome_trovato || '').toLowerCase()
      if (nomeTrovato && nomeHotel && nomeTrovato.includes(nomeHotel.toLowerCase().split(' ')[0])) score += 20
      const stelleTrovate = Number(parsed.stelle_trovate)
      if (stelleTrovate && stelle && Math.abs(stelleTrovate - parseFloat(String(stelle))) <= 1) score += 15
      const indirizzoTrovato = String(parsed.indirizzo_trovato || '').toLowerCase()
      if (indirizzoTrovato && citta && indirizzoTrovato.includes(citta.toLowerCase())) score += 15
      const telTrovato = String(parsed.telefono_trovato || '').replace(/\s/g, '')
      if (telTrovato && telefono && telTrovato === telefono.replace(/\s/g, '')) score += 10
    } else {
      score = 5
    }
    score = Math.min(100, score)

    // Salva ai_visibility in geo_scores
    await supabase.from('isi_sites').update({ geo_scores: { ...geo, ai_visibility: score } }).eq('site_id', site_id)

    return new Response(JSON.stringify({ ok: true, score, details: parsed }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
