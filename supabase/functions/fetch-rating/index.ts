const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .slice(0, 15000)
}

async function fetchPage(url: string): Promise<{ text: string; method: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    const text = stripHtml(await res.text())
    if (text.length > 400) return { text, method: `direct ${res.status}` }
  } catch (_) { /* fallback */ }

  // Jina.ai with both text and markdown modes
  for (const fmt of ['text', 'markdown']) {
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': fmt, 'X-Timeout': '20' },
        signal: AbortSignal.timeout(25000),
      })
      if (!jinaRes.ok) continue
      const text = (await jinaRes.text()).slice(0, 15000)
      if (text.length > 300) return { text, method: `jina-${fmt}` }
    } catch (_) { /* try next */ }
  }

  throw new Error('Pagina non raggiungibile')
}

function cleanNum(s: string): string {
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '')
  return s.replace(',', '.')
}

// rating: integer OR decimal (4 or 4,5 or 4.5)
const INT_OR_DEC = '(\\d(?:[,.]\\d)?)'
const INT_OR_DEC_1_5 = '([1-5](?:[,.]\\d)?)'
const INT_OR_DEC_BOOKING = '([6-9](?:[,.]\\d)?|10(?:[,.]0)?)'

function extractRating(text: string, source: string) {
  let rating: string | null = null
  let nRec: string | null = null

  if (source === 'tripadvisor') {
    // "4,5 di 5" / "4 di 5" / "4.5 su 5" / "4 of 5" / "4 out of 5"
    const m1 = text.match(new RegExp(`${INT_OR_DEC_1_5}\\s*(?:di|su|of|out\\s+of)\\s*5`, 'i'))
    // "4,5 bolle" / "4 bubbles" / "4,0 stelle"
    const m2 = text.match(new RegExp(`${INT_OR_DEC_1_5}\\s*(?:bolle|bubbles|stelle|stars?)`, 'i'))
    // "Eccellente" / quality word near a number
    const m3 = text.match(/(?:Eccellente|Molto buono|Buono|Discreto|Pessimo|Excellent|Very Good|Average|Poor|Terrible)\D{0,8}([1-5](?:[,.]\d)?)/i)
    const m3b = text.match(/([1-5](?:[,.]\d)?)\D{0,8}(?:Eccellente|Molto buono|Buono|Discreto|Eccezionale|Excellent|Very Good)/i)
    // Structured patterns from meta / og tags in stripped HTML
    const m4 = text.match(/ratingValue[^\d]*([1-5](?:[,.]\d)?)/i)
    // Last resort: any X,X or X.X between 1–5 near "rating" keyword
    const m5 = text.match(/rating[^\d]{0,20}([1-5][,.]\d)/i)
    const raw = m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? m3b?.[1] ?? m4?.[1] ?? m5?.[1] ?? null
    rating = raw ? cleanNum(raw) : null

    const mn = text.match(/([\d.]+\.?\d*)\s*(?:recensioni|reviews|opinioni|valutazioni)/i)
    nRec = mn ? mn[1].replace(/\./g, '') : null

  } else if (source === 'booking') {
    const qualWord = '(?:Eccellente|Fantastico|Superbo|Molto buono|Buono|Sufficiente|Scarso|Meraviglioso|Eccezionale|Outstanding|Fabulous|Superb|Very Good|Good|Pleasant|Fair|Poor|Wonderful)'
    const m1 = text.match(new RegExp(`${INT_OR_DEC_BOOKING}\\s*[^\\d]{0,30}${qualWord}`, 'i'))
    const m2 = text.match(new RegExp(`${qualWord}\\s*[^\\d]{0,30}${INT_OR_DEC_BOOKING}`, 'i'))
    const m3 = text.match(/(?:Punteggio|Valutazione|Score|Voto)[^\d]{0,15}([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i)
    const m4 = text.match(/ratingValue[^\d]*([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i)
    // Fallback: any X.X or X,X in range 7–10
    const m5 = text.match(/\b([789][,.]\d|10[,.]0)\b/)
    const raw = m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? m4?.[1] ?? m5?.[1] ?? null
    rating = raw ? cleanNum(raw) : null

    const mn = text.match(/([\d.]+\.?\d*)\s*(?:recensioni|commenti|reviews|valutazioni)/i)
    nRec = mn ? mn[1].replace(/\./g, '') : null

  } else if (source === 'google') {
    // "4,5 (1.234 recensioni)" / "4.5 (1,234 reviews)"
    const m1 = text.match(/([1-5][,.]\d)\s*\(\s*([\d.]+)\s*(?:recensioni|reviews|valutazioni)/i)
    // "rating: 4.5" / "ratingValue: 4.5"
    const m2 = text.match(/rating[^\d]{0,15}([1-5][,.]\d)/i)
    // any X.X near review count
    const m3 = text.match(/([1-5][,.]\d)[\s\S]{0,80}([\d.]+)\s*(?:recensioni|reviews)/i)
    const raw = m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? null
    rating = raw ? cleanNum(raw) : null

    const nRaw = m1?.[2] ?? (m3?.[2]) ?? text.match(/([\d.]+)\s*(?:recensioni|reviews)/i)?.[1] ?? null
    nRec = nRaw ? nRaw.replace(/\./g, '') : null
  }

  return { rating, n_recensioni: nRec }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { url, source } = await req.json() as { url: string; source: string }
    if (!url || !source) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { headers: cors })
    }

    let text = ''
    let method = ''
    try {
      const r = await fetchPage(url)
      text = r.text; method = r.method
    } catch (e) {
      return new Response(JSON.stringify({ error: 'fetch_failed', message: (e as Error).message }), { headers: cors })
    }

    const lower = text.toLowerCase()
    if (text.length < 400 && (lower.includes('captcha') || lower.includes('verify you are human') || lower.includes('access denied') || lower.includes('cloudflare'))) {
      return new Response(JSON.stringify({ error: 'blocked', snippet: text.slice(0, 200) }), { headers: cors })
    }

    const { rating, n_recensioni } = extractRating(text, source)

    // snippet for client-side console debug
    const snippet = text.slice(0, 400)

    return new Response(JSON.stringify({ ok: true, rating, n_recensioni, method, snippet }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
