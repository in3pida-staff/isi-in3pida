import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_API_KEY      = Deno.env.get('GEMINI_API_KEY') ?? ''
const GEMINI_KEY_BACKUP   = Deno.env.get('GEMINI_KEY') ?? ''
const GROQ_API_KEY        = Deno.env.get('GROQ_API_KEY') ?? ''
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

    // Normalizza URL: rimuovi parametri challenge/tracking per portali OTA noti
    let fetchUrl = url
    try {
      const u = new URL(url)
      if (/booking\.com|tripadvisor\./i.test(u.hostname)) {
        u.search = ''
        fetchUrl = u.toString()
      }
    } catch (_) { /* usa url originale */ }

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

    // Fallback Jina se fetch diretto fallisce o restituisce poco contenuto
    let jinaBlocked = false
    if (fetchErrMsg || pageText.length < 500) {
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${fetchUrl}`, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '15' },
          signal: AbortSignal.timeout(20000),
        })
        if (jinaRes.ok) {
          const jinaText = (await jinaRes.text()).slice(0, 9000)
          if (jinaText.length > 500) { pageText = jinaText; fetchErrMsg = '' }
        } else if (jinaRes.status === 429) {
          jinaBlocked = true
        }
      } catch (_) { /* ignora */ }
    }

    if (fetchErrMsg && (!pageText || pageText.length < 100)) {
      const msg = jinaBlocked
        ? 'Scansione automatica non disponibile per questo portale (protezione anti-bot). Riprova più tardi.'
        : `Impossibile accedere alla pagina: ${fetchErrMsg}. Verifica che il link sia corretto.`
      return new Response(JSON.stringify({ error: 'fetch_failed', message: msg }), { headers: cors })
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

    async function callGemini(apiKey: string): Promise<string | null> {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1200 },
            }),
            signal: AbortSignal.timeout(20000),
          }
        )
        const d = await res.json()
        if (d.error) return null
        return d.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      } catch { return null }
    }

    async function callGroq(): Promise<string | null> {
      if (!GROQ_API_KEY) return null
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt + '\n\nIMPORTANTE: Rispondi SOLO con JSON valido, nessun testo aggiuntivo.' }],
            max_tokens: 1200,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(20000),
        })
        const d = await res.json()
        if (d.error) return null
        const text = d.choices?.[0]?.message?.content ?? ''
        const m = text.match(/\[[\s\S]*\]/)
        return m ? m[0] : null
      } catch { return null }
    }

    let rawText = await callGemini(GEMINI_API_KEY)
    if (!rawText && GEMINI_KEY_BACKUP) rawText = await callGemini(GEMINI_KEY_BACKUP)
    if (!rawText) rawText = await callGroq()
    if (!rawText) {
      return new Response(JSON.stringify({
        error: 'ai_unavailable',
        message: 'Analisi AI temporaneamente non disponibile. Riprova tra qualche minuto.',
      }), { headers: cors })
    }

    let results: any[] = []
    try { results = JSON.parse(rawText) } catch { results = [] }

    // Se l'AI non ha trovato nessun campo, la pagina era probabilmente una challenge page
    const foundCount = results.filter((r: any) => r.found_value != null).length
    if (results.length > 0 && foundCount === 0) {
      return new Response(JSON.stringify({
        error: 'blocked',
        message: 'Scansione automatica non disponibile per questo portale (protezione anti-bot). Riprova più tardi.',
      }), { headers: cors })
    }

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
