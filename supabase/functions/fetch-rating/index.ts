const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim()
    .slice(0, 12000)
}

async function fetchDirect(url: string): Promise<string | null> {
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
    if (text.length > 400) return text
  } catch (_) { /* fallback */ }
  return null
}

async function fetchJina(url: string): Promise<string | null> {
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '15' },
      signal: AbortSignal.timeout(20000),
    })
    if (!jinaRes.ok) return null
    const text = (await jinaRes.text()).slice(0, 12000)
    if (text.length < 200) return null
    return text
  } catch { return null }
}

function cleanNum(s: string): string {
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '')
  return s.replace(',', '.')
}

function extractRating(text: string, source: string): { rating: string | null; n_recensioni: string | null } {
  let rating: string | null = null
  let nRec: string | null = null

  if (source === 'booking') {
    const patterns = [
      /([6-9](?:[,.]\d)?|10(?:[,.]\d)?)\s*(?:Eccellente|Fantastico|Superbo|Molto buono|Meraviglioso|Eccezionale|Outstanding|Fabulous|Wonderful|Very Good|Superb)/i,
      /(?:Eccellente|Fantastico|Superbo|Molto buono|Meraviglioso|Eccezionale|Outstanding|Fabulous|Wonderful)\s*[:\-]?\s*([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /(?:Punteggio|Valutazione|Score)[^\d]{0,15}([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /ratingValue[^\d"]{0,5}"?([6-9](?:[,.]\d)?|10(?:[,.]\d)?)/i,
      /\b([789][,.]\d|10[,.]0)\b/,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) { rating = cleanNum(m[1]); break }
    }
    const mn = text.match(/([\d.]+)\s*(?:recensioni|commenti|reviews)/i)
    nRec = mn ? mn[1].replace(/\./g,'') : null

  } else if (source === 'tripadvisor') {
    const patterns = [
      /([1-5](?:[,.]\d)?)\s*di\s*5/i,
      /([1-5](?:[,.]\d)?)\s*su\s*5/i,
      /([1-5](?:[,.]\d)?)\s*(?:of|out\s+of)\s*5/i,
      /(?:Eccellente|Molto buono|Buono|Discreto|Pessimo)[^\d]{0,10}([1-5](?:[,.]\d)?)/i,
      /([1-5](?:[,.]\d)?)[^\d]{0,10}(?:Eccellente|Molto buono|Buono)/i,
      /ratingValue[^\d"]{0,5}"?([1-5](?:[,.]\d)?)/i,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) { rating = cleanNum(m[1]); break }
    }
    const mn = text.match(/([\d.,]+)\s*(?:recensioni|reviews|opinioni)/i)
    nRec = mn ? mn[1].replace(/\./g,'').replace(',','') : null

  } else if (source === 'google') {
    const patterns = [
      /([1-5][,.]\d)\s*\(\s*([\d,.]+)\s*(?:recensioni|reviews)/i,
      /([1-5][,.]\d)\s*(?:su|di|out\s+of)\s*5/i,
      /ratingValue[^\d"]{0,5}"?([1-5][,.]\d)/i,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m?.[1]) { rating = cleanNum(m[1]); if (m[2]) nRec = m[2].replace(/\./g,'').replace(',',''); break }
    }
    if (!rating) {
      const m = text.match(/\n([1-5]\.[0-9])\n/)
      if (m) rating = m[1]
    }
    if (!nRec) {
      const mn = text.match(/([\d.,]+)\s*(?:recensioni|reviews)/i)
      nRec = mn ? mn[1].replace(/\./g,'') : null
    }
  }

  return { rating, n_recensioni: nRec }
}

async function findRating(url: string, source: string): Promise<{ rating: string | null; n_recensioni: string | null } | null> {
  const direct = await fetchDirect(url)
  if (direct) {
    const r = extractRating(direct, source)
    if (r.rating) return r
  }
  const jina = await fetchJina(url)
  if (jina) {
    const r = extractRating(jina, source)
    if (r.rating) return r
  }
  return null
}

async function findRatingFromHotelSite(hotelUrl: string, source: string): Promise<{ rating: string | null; n_recensioni: string | null } | null> {
  try {
    const res = await fetch(hotelUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const reSource = source === 'tripadvisor' ? /tripadvisor/gi : source === 'booking' ? /booking\.com/gi : null
    if (!reSource) return null
    let m
    reSource.lastIndex = 0
    while ((m = reSource.exec(html)) !== null) {
      const start = Math.max(0, m.index - 500)
      const end = Math.min(html.length, m.index + 700)
      const section = html.slice(start, end)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
        .replace(/\s+/g, ' ').trim()
      const r = extractRating(section, source)
      if (r.rating) return r
    }
  } catch { return null }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const rawUrl: string = body.url
    const source: string = body.source
    const hotelName: string = body.hotel_name || ''
    const hotelCity: string = body.hotel_city || ''
    const hotelSiteUrl: string = body.hotel_site_url || ''

    if (!rawUrl || !source) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { headers: cors })
    }

    let url = rawUrl
    try {
      const parsed = new URL(rawUrl)
      if (source === 'booking' || source === 'tripadvisor') {
        url = parsed.origin + parsed.pathname
      }
    } catch (_) { /* usa URL originale */ }

    if (source === 'booking') {
      const r = await findRating(url, 'booking')
      if (r) return new Response(JSON.stringify({ ok: true, ...r }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      if (hotelSiteUrl) {
        const rSite = await findRatingFromHotelSite(hotelSiteUrl, 'booking')
        if (rSite?.rating) return new Response(JSON.stringify({ ok: true, ...rSite }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, rating: null, n_recensioni: null, blocked: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (source === 'google') {
      const r = await findRating(url, 'google')
      if (r) return new Response(JSON.stringify({ ok: true, ...r }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      if (hotelName) {
        const query = encodeURIComponent(hotelName + (hotelCity ? ' ' + hotelCity : ''))
        const maps = await findRating('https://www.google.com/maps/search/' + query, 'google')
        if (maps) return new Response(JSON.stringify({ ok: true, ...maps }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, rating: null, n_recensioni: null, blocked: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (source === 'tripadvisor') {
      const r = await findRating(url, 'tripadvisor')
      if (r) return new Response(JSON.stringify({ ok: true, ...r }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      if (hotelSiteUrl) {
        const rSite = await findRatingFromHotelSite(hotelSiteUrl, 'tripadvisor')
        if (rSite?.rating) return new Response(JSON.stringify({ ok: true, ...rSite }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, rating: null, n_recensioni: null, blocked: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'unknown_source' }), { headers: cors })

  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
