import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { reportAiStatus } from '../_shared/alerts.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GEMINI_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

// Modelli Groq sicuri per il ripiego automatico (in ordine): se uno viene dismesso, prova il successivo
const GROQ_FALLBACKS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']
async function groqCall(model: string, systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number): Promise<any> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ] })
  })
  return await res.json()
}
async function groqModel(model: string, systemPrompt: string, userPrompt: string, maxTokens = 400, temperature = 0.7): Promise<string> {
  let d = await groqCall(model, systemPrompt, userPrompt, maxTokens, temperature)
  // Ripiego automatico: se il modello è stato dismesso/non esiste, riprova con uno sicuro → così il servizio NON si rompe
  const bad = ['model_not_found', 'model_decommissioned']
  if (bad.includes(d?.error?.code)) {
    for (const fb of GROQ_FALLBACKS) {
      if (fb === model) continue
      d = await groqCall(fb, systemPrompt, userPrompt, maxTokens, temperature)
      if (!bad.includes(d?.error?.code)) break
    }
  }
  return d.choices?.[0]?.message?.content?.trim() ?? ''
}

const groq = (s: string, u: string, t = 400, temp = 0.7) => groqModel('openai/gpt-oss-20b', s, u, t, temp)

async function gemini(systemPrompt: string, userPrompt: string, maxTokens = 800): Promise<string> {
  if (!GEMINI_API_KEY) return ''
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
      })
    }
  )
  const d = await res.json()
  if (d.error) {
    const code = d.error.code ?? 0
    if (code === 429) return '__quota_exceeded__'
    return ''
  }
  return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

function parseJson(raw: string): any {
  try { return JSON.parse(raw) } catch { /* empty */ }
  try { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {} } catch { return {} }
}

// Gemini con grounding Google Search (tier gratuito) — ritorna risposta reale + fonti citate
async function geminiGrounded(prompt: string, maxTokens = 800): Promise<{ text: string, sources: { url: string, title: string }[], error?: string }> {
  if (!GEMINI_API_KEY) return { text: '', sources: [], error: 'no_key' }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
        })
      }
    )
    const d = await res.json()
    if (d.error) return { text: '', sources: [], error: d.error.code === 429 ? 'quota_exceeded' : (d.error.message || 'gemini_error') }
    const cand = d.candidates?.[0]
    const text = (cand?.content?.parts || []).map((p: any) => p.text).filter(Boolean).join(' ').trim()
    const chunks = cand?.groundingMetadata?.groundingChunks || []
    const seen = new Set<string>()
    const sources: { url: string, title: string }[] = []
    for (const c of chunks) {
      const title = c.web?.title || ''
      const url = c.web?.uri || ''
      const key = title || url
      if (!key || seen.has(key)) continue
      seen.add(key)
      sources.push({ url, title })
    }
    return { text, sources }
  } catch (e) {
    return { text: '', sources: [], error: String(e).slice(0, 200) }
  }
}

function countMentions(text: string, term: string): number {
  if (!term) return 0
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (text.match(new RegExp(esc, 'gi')) || []).length
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const { site_id, query, action } = body

    // ─── DEBUG GROQ COMPOUND (ispezione struttura fonti) ──────────────────────
    if (action === 'debug_groq') {
      const model = body.model || 'groq/compound'
      let out: any = {}
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Elenca i migliori hotel 3 stelle fronte mare a Riccione per famiglie, con i nomi. Rispondi in italiano.' }], temperature: 0.3 })
        })
        out = await r.json()
      } catch (e) { out = { fetchError: String(e) } }
      const msg = out.choices?.[0]?.message || {}
      return new Response(JSON.stringify({
        model,
        error: out.error || null,
        content_head: (msg.content || '').slice(0, 200),
        message_keys: Object.keys(msg),
        executed_tools: msg.executed_tools ?? null,
        reasoning_head: (msg.reasoning || '').slice(0, 200),
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ─── DEBUG ───────────────────────────────────────────────────────────────
    if (action === 'debug') {
      const key = GEMINI_API_KEY
      let geminiDebug: any = {}
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role:'user', parts:[{ text:'Say hello' }] }], generationConfig:{ maxOutputTokens:20 } })
        })
        geminiDebug = await r.json()
      } catch(e) { geminiDebug = { fetchError: String(e) } }
      return new Response(JSON.stringify({
        GEMINI_KEY_set: !!Deno.env.get('GEMINI_KEY'),
        GEMINI_API_KEY_set: !!Deno.env.get('GEMINI_API_KEY'),
        GROQ_KEY_set: !!Deno.env.get('GROQ_API_KEY'),
        gemini_response: geminiDebug,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ─── DETECT WRITING STYLE ────────────────────────────────────────────────
    if (action === 'detect_style') {
      if (!site_id) return new Response(JSON.stringify({ error: 'Missing site_id' }), { status: 400, headers: cors })
      if (!GROQ_API_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY non configurata' }), { status: 422, headers: cors })

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: site } = await supabase.from('isi_sites').select('hotel_profile,schema_data,site_name').eq('site_id', site_id).single()
      if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

      const hp = site.hotel_profile || {}
      const sc = site.schema_data   || {}
      const siteUrl = hp.sito_web || sc.url || ''

      let pageText = ''
      if (siteUrl) {
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 8000)
          const resp = await fetch(siteUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
          clearTimeout(timer)
          const html = await resp.text()
          pageText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .slice(0, 3000)
        } catch { /* fallback to description */ }
      }

      const textSource = pageText.trim() || (sc.description || hp.descrizione || '').slice(0, 2000)
      if (!textSource.trim()) return new Response(JSON.stringify({ error: 'no_text_source' }), { status: 422, headers: cors })

      const raw = await groq(
        `Sei un esperto di comunicazione alberghiera. Analizza il testo estratto dal sito di un hotel e restituisci il suo stile comunicativo in JSON.

Campi da restituire:
- "tono": una parola sola tra: formale, professionale, informale, familiare, elegante, vivace
- "persona": la forma di cortesia usata verso il cliente: "tu", "lei", o "misto". REGOLA CRITICA: usa "tu" solo se l'hotel si rivolge direttamente ai clienti con il tu (es. "sei il benvenuto", "scegli la tua camera"). Usa "lei" se usa il formale singolare (es. "la aspettiamo", "può prenotare"). Frasi standard come "vi aspettiamo", "vi offriamo", "vi invitiamo" sono locuzioni generali italiane che NON indicano la forma "voi" come cortesia — in questi casi usa "lei" o "tu" in base al resto del testo. "voi" come forma di cortesia singolare è arcaico e rarissimo, non usarlo a meno che il testo non usi esplicitamente "voi siete", "quando arrivate voi" riferito a un singolo cliente.
- "personalita": 2-3 parole che descrivono il carattere del testo (es. "caldo e accogliente", "lussuoso e raffinato", "allegro e dinamico")
- "esempio": una frase breve (max 100 caratteri) copiata LETTERALMENTE dal testo del sito che rappresenta bene il tono. Se non trovi una frase chiara, lascia il campo vuoto "".

Formato (JSON puro, nessun testo fuori dal JSON):
{"tono":"...","persona":"...","personalita":"...","esempio":"..."}`,
        `Testo dal sito:\n${textSource}`,
        250,
        0.3
      )
      const parsed = parseJson(raw)
      if (!parsed.tono) return new Response(JSON.stringify({ error: 'style_not_detected' }), { status: 500, headers: cors })
      // Rimuove esempio se contiene artefatti del prompt (es. "Rispondi con JSON")
      const artifatti = ['json', 'rispondi', 'formato', 'campo', 'esempio:', 'tono:', 'persona:']
      if (parsed.esempio && artifatti.some(a => parsed.esempio.toLowerCase().includes(a))) parsed.esempio = ''
      return new Response(JSON.stringify({ writing_style: parsed }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

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

      const ws = hp.writing_style || {}
      const styleInstructions = ws.tono
        ? `\nSTILE DI COMUNICAZIONE DELL'HOTEL:\n- Tono: ${ws.tono}${ws.persona ? ` — usa la forma "${ws.persona}"` : ''}\n- Personalità: ${ws.personalita || ''}\n${ws.esempio ? `- Esempio dal sito: "${ws.esempio}"\n` : ''}Adatta la risposta a questo stile specifico, mantenendo la stessa voce e personalità del sito dell'hotel.`
        : '\nTono: caldo, professionale, promozionale.'

      const raw = await groq(
        `Sei il responsabile marketing di un hotel italiano. Il tuo compito è scrivere risposte FAQ promozionali e convincenti.

REGOLA ASSOLUTA: devi SEMPRE scrivere una risposta completa e positiva, qualunque sia la domanda. Non esistono eccezioni.

COSA FARE:
- Usa i dati forniti quando disponibili (nome hotel, stelle, servizi, posizione, ecc.)
- Se mancano dati specifici, rispondi comunque in modo verosimile e promozionale basandoti sul tipo di struttura e sulla domanda — come farebbe un bravo ufficio marketing
- Lunghezza: 2-4 frasi
- Lingua: italiano
${styleInstructions}

COSA NON FARE MAI (pena risposta scartata):
- Non scrivere "non ho informazioni", "non sono in grado", "non posso", "visita il sito", "contatta la reception" come unica risposta
- Non dire che mancano dati
- Non rifiutarti di rispondere
- Non inventare prezzi esatti, numeri di camere esatti o orari precisi se non forniti

CAMPO "sufficient":
- true = risposta basata su dati concreti forniti
- false = risposta plausibile ma non basata su dati specifici (l'utente potrà personalizzarla)

Formato risposta (JSON puro, nessun testo fuori):
{"answer":"<risposta promozionale in italiano>","sufficient":<true|false>}`,
        `Dati hotel:\n${lines}\n\nDomanda FAQ: "${query}"\n\nRispondi con JSON:`,
        500,
        0.5
      )

      const parsed = parseJson(raw)
      if (!parsed.answer) return new Response(JSON.stringify({ error: 'empty_response' }), { status: 500, headers: cors })
      return new Response(
        JSON.stringify({ answer: parsed.answer, sufficient: parsed.sufficient !== false }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    // ─── AI VISIBILITY (reale, grounded) ──────────────────────────────────────
    // Interroga davvero Gemini con Google Search grounding: dice se l'hotel è citato,
    // come sta vs i competitor (Share of Voice) e da quali fonti l'AI prende le info.
    if (action === 'ai_visibility') {
      if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })
      if (!GEMINI_API_KEY) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY non configurata' }), { status: 422, headers: cors })

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const { data: site } = await supabase.from('isi_sites').select('site_name, hotel_profile, schema_data').eq('site_id', site_id).single()
      if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors })

      const hp = site.hotel_profile || {}
      const sc = site.schema_data || {}
      const hotelName = (body.hotel_context?.nome || sc.name || hp.nome_hotel || hp.nome || site.site_name || '').trim()
      const aliases = [hotelName, ...(Array.isArray(body.aliases) ? body.aliases : [])].map((a: string) => (a || '').trim()).filter(Boolean)
      const competitors = (Array.isArray(body.competitors) ? body.competitors : [])
        .map((c: string) => (c || '').trim()).filter(Boolean).slice(0, 3)

      // Query reale con grounding
      const gr = await geminiGrounded(query)
      if (gr.error === 'quota_exceeded')
        return new Response(JSON.stringify({ error: 'quota_exceeded', message: 'Limite giornaliero gratuito Gemini raggiunto, riprova domani.' }), { status: 429, headers: cors })
      if (!gr.text)
        return new Response(JSON.stringify({ error: 'no_answer', message: gr.error || 'Nessuna risposta dal motore AI' }), { status: 502, headers: cors })

      const answer = gr.text
      const answerLc = answer.toLowerCase()

      // Citazione hotel + posizione
      const hitAlias = aliases.find((a: string) => answerLc.includes(a.toLowerCase()))
      const cited = !!hitAlias
      const position = cited ? answerLc.indexOf((hitAlias as string).toLowerCase()) : -1
      const myMentions = aliases.reduce((n: number, a: string) => n + countMentions(answer, a), 0)

      // Share of Voice vs competitor
      const compCounts = competitors.map((name: string) => ({ name, mentions: countMentions(answer, name) }))
      const totalMentions = myMentions + compCounts.reduce((s: number, c: any) => s + c.mentions, 0)
      const sov = totalMentions > 0 ? Math.round((myMentions / totalMentions) * 100) : (cited ? 100 : 0)

      const result = {
        query,
        cited,
        position,
        my_mentions: myMentions,
        sov,
        competitors: compCounts,
        sources: gr.sources.slice(0, 8),
        answer_excerpt: answer.slice(0, 600),
        checked_at: new Date().toISOString(),
        model: 'gemini-2.0-flash (grounded)'
      }

      // Salva competitor scelti + ultimo run nel profilo (storico leggero, zero costi)
      await supabase.from('isi_sites')
        .update({ hotel_profile: { ...hp, pse_competitors: competitors, last_ai_visibility: result } })
        .eq('site_id', site_id)

      return new Response(JSON.stringify({ ok: true, result }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ─── PSE QUERY ────────────────────────────────────────────────────────────
    if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase.from('isi_sites').select('pse_enabled, site_name, hotel_profile').eq('site_id', site_id).single()
    if (!site?.pse_enabled) return new Response(JSON.stringify({ error: 'PSE not enabled' }), { status: 403, headers: cors })
    if (!GROQ_API_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY non configurata' }), { status: 422, headers: cors })

    const systemPrompt = `Sei un esperto di GEO (Generative Engine Optimization) per hotel italiani. Analizzi se un hotel verrebbe citato da ChatGPT, Perplexity o Google AI in risposta a una query specifica.

REGOLE per i suggerimenti:
- Ogni suggerimento deve riferirsi a un dato CONCRETO che manca o è debole nel profilo rispetto alla query ricevuta
- NON suggerire cose già presenti nel profilo (es. se le stelle ci sono, non dirlo)
- NON suggerire cose generiche come "aggiornare il sito" o "migliorare la visibilità"
- Ogni suggerimento deve iniziare con un'azione specifica: "Aggiungi...", "Descrivi...", "Specifica...", "Inserisci...", "Crea una FAQ su..."
- Collegare il suggerimento alla query: se la query è "hotel per famiglie", i suggerimenti devono riguardare servizi famiglia mancanti, non le stelle

Rispondi SOLO con JSON valido, nessun testo fuori:
{
  "probability": <0-100, quanto è probabile che questo hotel venga citato per QUESTA query>,
  "verdict": "<Molto probabile|Probabile|Incerto|Improbabile|Molto improbabile>",
  "why": "<spiega in 1-2 frasi cosa nel profilo supporta o indebolisce la citazione per questa query specifica>",
  "strengths": ["<punto di forza del profilo rilevante per questa query>","<altro punto di forza>"],
  "weaknesses": ["<lacuna del profilo rilevante per questa query>","<altra lacuna>"],
  "suggestions": ["<azione concreta e specifica basata su dato mancante nel profilo>","<seconda azione>","<terza azione>"],
  "sample_answer": "<frase di esempio come la direbbe ChatGPT citando questo hotel per questa query>"
}`

    const userPrompt = `Profilo hotel:\n${JSON.stringify(body.hotel_context, null, 2)}\n\nQuery utente: "${query}"`

    // Esegui ChatGPT (Llama 8B) + Gemini (Llama 70B) + Perplexity (GPT-OSS 20B) in parallelo — stesso GROQ_API_KEY, zero costi aggiuntivi
    // Nota: gemma2-9b-it è stato dismesso da Groq → sostituito con openai/gpt-oss-20b. Gli errori per modello vengono tracciati come avvisi admin.
    const _engineErrors: Array<{engine:string, model:string, error:string}> = []
    const _run = (engine:string, model:string) =>
      groqModel(model, systemPrompt, userPrompt, 800).catch((e) => { _engineErrors.push({ engine, model, error: String(e).slice(0,300) }); return '' })
    const [rawChatgpt, rawGeminiAlt, rawPerplexity] = await Promise.all([
      _run('chatgpt',    'openai/gpt-oss-20b'),
      _run('gemini',     'openai/gpt-oss-120b'),
      _run('perplexity', 'openai/gpt-oss-20b')
    ])

    const chatgptResult    = parseJson(rawChatgpt)
    const geminiAltResult  = parseJson(rawGeminiAlt)
    const perplexityResult = parseJson(rawPerplexity)

    // Motori AI: avviso SOLO admin quando non rispondono, e "tornato disponibile" quando riprendono
    await reportAiStatus(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'llm:chatgpt',    rawChatgpt    !== '', 'Simulatore — motore ChatGPT',    { source:'pse', engine:'chatgpt',    model:'openai/gpt-oss-20b' })
    await reportAiStatus(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'llm:gemini',     rawGeminiAlt  !== '', 'Simulatore — motore Gemini',     { source:'pse', engine:'gemini',     model:'openai/gpt-oss-120b' })
    await reportAiStatus(SUPABASE_URL, SUPABASE_SERVICE_KEY, 'llm:perplexity', rawPerplexity !== '', 'Simulatore — motore Perplexity', { source:'pse', engine:'perplexity', model:'openai/gpt-oss-20b' })

    const chatgptCited    = (chatgptResult.probability    ?? 0) >= 50
    const geminiAltCited  = (geminiAltResult.probability  ?? 0) >= 50
    const perplexityCited = (perplexityResult.probability ?? 0) >= 50

    // Probability media tra i tre motori come valore principale
    const probs = [chatgptResult.probability, geminiAltResult.probability, perplexityResult.probability].filter(p => p != null) as number[]
    const avgProb = probs.length ? Math.round(probs.reduce((a,b)=>a+b,0)/probs.length) : (chatgptResult.probability ?? null)

    const result = {
      ...chatgptResult,
      probability: avgProb,
      verdict: chatgptResult.verdict ?? null,
      llm_results: {
        chatgpt: {
          probability: chatgptResult.probability ?? null,
          verdict: chatgptResult.verdict ?? null,
          cited: chatgptCited,
          model: 'openai/gpt-oss-20b'
        },
        gemini: {
          probability: geminiAltResult.probability ?? null,
          verdict: geminiAltResult.verdict ?? null,
          cited: geminiAltCited,
          model: 'openai/gpt-oss-120b'
        },
        perplexity: {
          probability: perplexityResult.probability ?? null,
          verdict: perplexityResult.verdict ?? null,
          cited: perplexityCited,
          model: 'openai/gpt-oss-20b'
        }
      }
    }

    // Trova tutte le righe con la stessa query (case-insensitive) per questo sito
    const { data: existingRows } = await supabase
      .from('isi_pse_queries').select('id')
      .eq('site_id', site_id).ilike('query', query.trim()).limit(20)

    const model = 'chatgpt+gemini+perplexity'

    if (existingRows && existingRows.length > 0) {
      const keepId = existingRows[0].id
      const dupeIds = existingRows.slice(1).map((r: any) => r.id)
      if (dupeIds.length > 0) await supabase.from('isi_pse_queries').delete().in('id', dupeIds)
      await supabase.from('isi_pse_queries').update({ result, model, tokens_in:0, tokens_out:0, cost_usd:0 }).eq('id', keepId)
    } else {
      await supabase.from('isi_pse_queries').insert({
        site_id, site_name: site.site_name, query: query.trim(),
        tokens_in: 0, tokens_out: 0, cost_usd: 0, model, result
      })
    }

    return new Response(JSON.stringify({ ok: true, result, cost_usd: 0 }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
