const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// Estrae aggregateRating dai JSON-LD nella pagina
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

function stripSection(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function stripHtml(html: string): string {
  return stripSection(html).slice(0, 15000)
}

function extractFromMeta(html: string): { rating: string | null; n_recensioni: string | null } {
  const desc = (html.match(/<meta[^>]+(?:name=["']description["']|property=["']og:description["'])[^>]+content=["']([^"']+)["']/i) || [])[1] || ''
  const ratingM = desc.match(/([1-5][,.]\d)\s*(?:su|di|\/)\s*5/i) || desc.match(/([4-9][,.]\d|10[,.]\d?)\s*(?:su|di|\/)\s*10/i)
  const nM = desc.match(/([\d.]+)\s*(?:recensioni|reviews|opinioni)/i)
  return {
    rating: ratingM ? cleanNum(ratingM[1]) : null,
    n_recensioni: nM ? nM[1].replace(/\./g, '') : null,
  }
}

async function fetchDirect(url: string): Promise<{ html: string; text: string } | null> {
  const attempts = [
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.7', 'Accept-Encoding': 'gzip, deflate, br' } },
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9' } },
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Accept': 'text/html,*/*;q=0.8' } },
  ]
  for (const opts of attempts) {
    try {
      const res = await fetch(url, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(12000) })
      if (!res.ok) continue
      const html = await res.text()
      const text = stripHtml(html)
      if (text.length > 300) return { html, text }
    } catch { /* prova prossimo */ }
  }
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

// Cerca il badge/widget del portale nel sito web dell'hotel
function extractFromHotelSite(html: string, source: string): { rating: string | null; n_recensioni: string | null } {
  const sourceRe = source === 'tripadvisor'
    ? /tripadvisor/gi
    : source === 'booking'
    ? /booking\.com/gi
    : /google[^\n]{0,80}(?:review|stelle|star|valutaz|recensi|rating)/gi

  let match
  while ((match = sourceRe.exec(html)) !== null) {
    const start = Math.max(0, match.index - 500)
    const end = Math.min(html.length, match.index + 700)
    const section = stripSection(html.slice(start, end))
    const result = extractFromText(section, source)
    if (result.rating) return result
  }
  return { rating: null, n_recensioni: null }
}

// Valida che il rating JSON-LD sia sulla scala giusta per la source
function validateJsonLdForSource(ld: { rating: string | null; n_recensioni: string | null }, source: string): boolean {
  if (!ld.rating) return false
  const v = parseFloat(ld.rating)
  if (isNaN(v)) return false
  if ((source === 'tripadvisor' || source === 'google') && v >= 1 && v <= 5) return true
  if (source === 'booking' && v >= 5 && v <= 10) return true
  return false
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { url: rawUrl, source, hotel_site_url: hotelSiteUrl } = await req.json() as { url: string; source: string; hotel_site_url?: string }
    if (!rawUrl || !source) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { headers: cors })
    }

    // Pulisce l'URL rimuovendo query params (es. token Cloudflare di Booking ?chal_t=...)
    let url = rawUrl
    try {
      const parsed = new URL(rawUrl)
      if (source === 'booking' || source === 'tripadvisor') {
        url = parsed.origin + parsed.pathname
      }
    } catch { /* usa URL originale */ }

    // Per TripAdvisor prova URL mobile che ha meno protezione bot
    let urlToFetch = url
    if (source === 'tripadvisor') {
      urlToFetch = url.replace('www.tripadvisor.', 'm.tripadvisor.')
    }

    // 1. Prova fetch diretto del portale (JSON-LD prima, poi meta, poi testo)
    const direct = await fetchDirect(urlToFetch) || (source === 'tripadvisor' ? await fetchDirect(url) : null)
    if (direct) {
      const fromLd = extractFromJsonLd(direct.html)
      if (fromLd.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromLd, method: 'json-ld' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const fromMeta = extractFromMeta(direct.html)
      if (fromMeta.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromMeta, method: 'meta' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const fromText = extractFromText(direct.text, source)
      if (fromText.rating) {
        return new Response(JSON.stringify({ ok: true, ...fromText, method: 'direct-text' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    // 2. Fallback: legge il sito web dell'hotel e cerca badge/widget del portale
    if (hotelSiteUrl) {
      const hotelPage = await fetchDirect(hotelSiteUrl)
      if (hotelPage) {
        // Prima prova JSON-LD del sito hotel (molti hotel hanno aggregateRating in schema.org)
        const fromLd = extractFromJsonLd(hotelPage.html)
        if (validateJsonLdForSource(fromLd, source)) {
          return new Response(JSON.stringify({ ok: true, ...fromLd, method: 'hotel-site-ld' }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        // Cerca il badge/widget del portale specifico nel sito dell'hotel
        const fromBadge = extractFromHotelSite(hotelPage.html, source)
        if (fromBadge.rating) {
          return new Response(JSON.stringify({ ok: true, ...fromBadge, method: 'hotel-site-badge' }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
      }
    }

    // 3. Nessun dato trovato
    if (direct) {
      return new Response(JSON.stringify({ ok: true, rating: null, n_recensioni: null, method: 'direct-nodata' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'fetch_failed', message: 'Pagina non raggiungibile' }), { headers: cors })

  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
