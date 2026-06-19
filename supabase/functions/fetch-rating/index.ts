const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// Estrae aggregateRating dai JSON-LD nella pagina (prima di strippare)
function extractFromJsonLd(html: string): { rating: string | null; n_recensioni: string | null } {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1].trim())
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const ar = item?.aggregateRating
        if (ar) {
          const rating = ar.ratingValue != null ? String(ar.ratingValue).replace(',', '.') : null
          const n = ar.reviewCount != null ? String(ar.reviewCount) : ar.ratingCount != null ? String(ar.ratingCount) : null
          if (rating) return { rating, n_recensioni: n }
        }
      }
    } catch { /* ignora JSON malformato */ }
  }
  return { rating: null, n_recensioni: null }
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

async function fetchDirect(url: string): Promise<{ html: string; text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    const html = await res.text()
    const text = stripHtml(html)
    if (text.length > 300) return { html, text }
  } catch { /* fallback */ }
  return null
}

async function fetchJinaText(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '25', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const text = (await res.text()).slice(0, 15000)
    if (text.length > 300) return text
  } catch { /* fallback */ }
  return null
}

async function fetchJinaHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '25', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const html = (await res.text()).slice(0, 60000)
    if (html.length > 300) return html
  } catch { /* fallback */ }
  return null
}

function cleanNum(s: string): string {
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '')
  return s.replace(',', '.')
}

function extractFromText(text: string, source: string): { rating: string | null; n_recensioni: string | null } {
  let rating: string | null = null
  let nRec: string | null = null

  if (source === 'tripadvisor') {
    // Tenta tutti i pattern TripAdvisor
    const patterns = [
      /([1-5](?:[,.]\d)?)\s*di\s*5/i,
      /([1-5](?:[,.]\d)?)\s*su\s*5/i,
      /([1-5](?:[,.]\d)?)\s*(?:of|out\s+of)\s*5/i,
      /([1-5](?:[,.]\d)?)\s*(?:bolle|bubbles|stelle)/i,
      /(?:Eccellente|Molto buono|Buono|Discreto|Pessimo|Eccezionale)[^\d]{0,10}([1-5](?:[,.]\d)?)/i,
      /([1-5](?:[,.]\d)?)[^\d]{0,10}(?:Eccellente|Molto buono|Buono)/i,
      /ratingValue[^\d"]{0,5}"?([1-5](?:[,.]\d)?)/i,
      /rating[:\s]+([1-5](?:[,.]\d)?)/i,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) { rating = cleanNum(m[1]); break }
    }
    const mn = text.match(/([\d.,]+)\s*(?:recensioni|reviews|opinioni|valutazioni)/i)
    nRec = mn ? mn[1].replace(/\./g, '').replace(',', '') : null

  } else if (source === 'booking') {
    const patterns = [
      /([6-9](?:[,.]\d)?|10(?:[,.]\d)?)\s*(?:Eccellente|Fantastico|Superbo|Molto buono|Buono|Meraviglioso|Eccezionale|Outstanding|Fabulous|Wonderful|Very Good|Superb)/i,
      /(?:Eccellente|Fantastico|Superbo|Molto buono|Meraviglioso|Eccezionale|Outstanding|Fabulous|Wonderful)\s*[:\-]?\s*([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /(?:Punteggio|Valutazione|Score)[^\d]{0,15}([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /ratingValue[^\d"]{0,5}"?([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /\b([789][,.]\d|10[,.]0)\b/,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) { rating = cleanNum(m[1]); break }
    }
    const mn = text.match(/([\d.]+)\s*(?:recensioni|commenti|reviews|valutazioni)/i)
    nRec = mn ? mn[1].replace(/\./g, '') : null

  } else if (source === 'google') {
    const patterns = [
      /([1-5][,.]\d)\s*\(\s*([\d,.]+)\s*(?:recensioni|reviews)/i,
      /([1-5][,.]\d)\s*(?:su|di|out\s+of)\s*5/i,
      /ratingValue[^\d"]{0,5}"?([1-5][,.]\d)/i,
      /rating[:\s]+([1-5][,.]\d)/i,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) {
        rating = cleanNum(m[1])
        if (m[2]) nRec = m[2].replace(/\./g, '').replace(',', '')
        break
      }
    }
    if (!nRec) {
      const mn = text.match(/([\d.,]+)\s*(?:recensioni|reviews)/i)
      nRec = mn ? mn[1].replace(/\./g, '') : null
    }
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

    // 1. Prova fetch diretto con estrazione JSON-LD (più affidabile)
    const direct = await fetchDirect(url)
    if (direct) {
      const fromLd = extractFromJsonLd(direct.html)
      if (fromLd.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromLd, method: 'json-ld' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      // Prova regex sul testo strippato
      const fromText = extractFromText(direct.text, source)
      if (fromText.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromText, method: 'direct-text' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    // 2. Fallback Jina.ai text (JS-rendered, testo pulito)
    const jinaText = await fetchJinaText(url)
    if (jinaText) {
      const fromJina = extractFromText(jinaText, source)
      if (fromJina.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromJina, method: 'jina-text' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    // 3. Fallback Jina.ai HTML renderizzato (include JSON-LD post-JS)
    const jinaHtml = await fetchJinaHtml(url)
    if (jinaHtml) {
      const fromLd = extractFromJsonLd(jinaHtml)
      if (fromLd.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromLd, method: 'jina-html-ld' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const fromText = extractFromText(stripHtml(jinaHtml), source)
      if (fromText.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromText, method: 'jina-html-text' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      // Jina ha raggiunto la pagina ma non ha trovato dati
      return new Response(JSON.stringify({ ok: true, rating: null, n_recensioni: null, method: 'jina-html-nodata' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'fetch_failed', message: 'Pagina non raggiungibile' }), { headers: cors })

  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
