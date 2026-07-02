import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_API_KEY      = Deno.env.get('GEMINI_API_KEY') ?? ''
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return text.slice(0, 9000)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { site_id, channel, url } = await req.json()
    if (!site_id || !channel || !url)
      return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const { data: site } = await supabase
      .from('isi_sites')
      .select('hotel_profile, schema_data, site_name')
      .eq('site_id', site_id)
      .single()

    if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

    const hp = site.hotel_profile || {}
    const sc = site.schema_data   || {}

    const addr = [hp.via, hp.numero_civico, hp.cap, hp.citta].filter(Boolean).join(', ') ||
                 [sc.street, sc.city, sc.postal_code].filter(Boolean).join(', ') || ''

    const refData: Record<string, string> = {
      'Nome struttura': sc.name || hp.nome_hotel || hp.nome || site.site_name || '',
      'Stelle':         String(sc.starRating?.ratingValue || sc.official_rating || hp.stelle || ''),
      'Indirizzo':      addr,
      'Telefono':       hp.telefono || sc.telephone || '',
      'Email':          hp.email || sc.email || '',
      'Check-in':       hp.checkin_dalle || sc.checkin_time || '',
      'Check-out':      hp.checkout_alle || sc.checkout_time || '',
      'Sito web':       hp.sito_web || sc.url || '',
    }

    // Normalizza URL
    let fetchUrl = url.trim()
    if (!/^https?:\/\//i.test(fetchUrl)) fetchUrl = 'https://' + fetchUrl

    // Fetch della pagina
    let pageText = ''
    let fetchErrMsg = ''
    try {
      const pageRes = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      })
      const html = await pageRes.text()
      pageText = stripHtml(html)
      if (!pageRes.ok) fetchErrMsg = `HTTP ${pageRes.status}`
    } catch (e) {
      fetchErrMsg = (e as Error).message
    }

    if (fetchErrMsg && (!pageText || pageText.length < 100)) {
      return new Response(JSON.stringify({
        error: 'fetch_failed',
        message: `Impossibile accedere alla pagina: ${fetchErrMsg}. Verifica che il link sia corretto.`,
      }), { headers: cors })
    }

    if (!pageText || pageText.length < 100) {
      return new Response(JSON.stringify({
        error: 'empty_page',
        message: 'La pagina non contiene testo leggibile.',
      }), { headers: cors })
    }

    // Rileva captcha
    const lower = pageText.toLowerCase()
    const isBlocked = (lower.includes('captcha') || lower.includes('verify you are human') || lower.includes('access denied')) && pageText.length < 3000
    if (isBlocked) {
      return new Response(JSON.stringify({
        error: 'blocked',
        message: 'La pagina ha richiesto una verifica anti-bot. Scansione non disponibile per questo portale.',
      }), { headers: cors })
    }

    const refLines = Object.entries(refData)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')

    const prompt = `Sei un esperto nell'analisi di pagine web di hotel italiani.

Dati ufficiali dell'hotel (fonte: sito web/plugin):
${refLines}

Testo estratto dalla pagina ${channel} (${url}):
${pageText}

Confronta ogni campo dei dati ufficiali con ciò che trovi nel testo della pagina.

Regole di confronto:
- Nome: ignora maiuscole/minuscole e piccole differenze tipografiche
- Stelle: "4 stelle", "4★", "****", "Four Stars" sono equivalenti
- Telefono: considera uguali numeri con/senza prefisso (+39), spazi o trattini
- Indirizzo: confronto parziale tollerante (basta che via e città corrispondano)
- Check-in/out: considera uguali "dalle 14:00", "14:00", "14h" ecc.
- Se un campo non è presente nella pagina: found_value deve essere null

Rispondi SOLO con JSON valido (array):
[
  {"field":"Nome struttura","our_value":"...","found_value":"...", "match":true},
  {"field":"Stelle","our_value":"...","found_value":"...","match":true},
  {"field":"Indirizzo","our_value":"...","found_value":"...","match":true},
  {"field":"Telefono","our_value":"...","found_value":"...","match":false},
  {"field":"Email","our_value":"...","found_value":null,"match":false},
  {"field":"Check-in","our_value":"...","found_value":"...","match":true},
  {"field":"Check-out","our_value":"...","found_value":"...","match":true},
  {"field":"Sito web","our_value":"...","found_value":"...","match":true}
]`

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1200 },
        }),
      }
    )

    const geminiData = await geminiRes.json()
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'

    let results: any[] = []
    try { results = JSON.parse(rawText) } catch { results = [] }

    // Assicura che our_value sia sempre valorizzato
    results = results.map((r: any) => ({
      field:       r.field,
      our_value:   r.our_value || refData[r.field] || '',
      found_value: r.found_value ?? null,
      match:       !!r.match,
    }))

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
