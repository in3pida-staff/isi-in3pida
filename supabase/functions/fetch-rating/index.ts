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

  const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '15' },
    signal: AbortSignal.timeout(20000),
  })
  if (!jinaRes.ok) throw new Error(`Jina HTTP ${jinaRes.status}`)
  const text = (await jinaRes.text()).slice(0, 15000)
  if (text.length < 200) throw new Error(`Contenuto troppo breve`)
  return { text, method: 'jina' }
}

function cleanNum(s: string): string {
  // "1.234" IT thousands → "1234", "1,234" EN thousands → "1234"
  // but "4,5" IT decimal → "4.5"
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '')
  return s.replace(',', '.')
}

function extractRating(text: string, source: string) {
  let rating: string | null = null
  let nRec: string | null = null

  if (source === 'tripadvisor') {
    // Score X.X su 5 / di 5 / of 5 / out of 5
    const m1 = text.match(/\b([1-5][,.]\d)\s*(?:di|su|of|out\s+of)\s*5/i)
    // "Eccellente 4,5" or "Molto buono 3,5"
    const m2 = text.match(/(?:Eccellente|Molto buono|Buono|Discreto|Pessimo|Excellent|Very Good|Average|Poor|Terrible)\D{0,5}([1-5][,.]\d)/i)
    // Fallback: first X.X near "bolle" or "bubbles"
    const m3 = text.match(/([1-5][,.]\d)\s*(?:bolle|bubbles)/i)
    const raw = (m1?.[1] || m2?.[1] || m3?.[1] || null)
    rating = raw ? cleanNum(raw) : null

    const mn = text.match(/([\d.,]+)\s*(?:recensioni|reviews|opinioni|valutazioni)/i)
    nRec = mn ? cleanNum(mn[1]).replace(/\D/g, '') : null

  } else if (source === 'booking') {
    // Score 6–10 near quality word (IT or EN)
    const qualWord = '(?:Eccellente|Fantastico|Superbo|Molto buono|Buono|Sufficiente|Scarso|Outstanding|Fabulous|Superb|Very Good|Good|Pleasant|Fair|Poor)'
    const m1 = text.match(new RegExp(`\\b([6-9]\\d?[,.]\\d|10(?:[,.]0)?)\\b[\\s\\S]{0,40}${qualWord}`, 'i'))
    const m2 = text.match(new RegExp(`${qualWord}[\\s\\S]{0,40}\\b([6-9]\\d?[,.]\\d|10(?:[,.]0)?)\\b`, 'i'))
    // Punteggio X.X / Valutazione X.X
    const m3 = text.match(/(?:Punteggio|Valutazione|Score)[^\d]{0,10}([6-9]\d?[,.]\d|10(?:[,.]0)?)/i)
    // Final fallback: any 8.X or 9.X
    const m4 = text.match(/\b([89][,.]\d)\b/)
    const raw = m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? m4?.[1] ?? null
    rating = raw ? cleanNum(raw) : null

    const mn = text.match(/([\d.,]+)\s*(?:recensioni|commenti|reviews|valutazioni)/i)
    nRec = mn ? mn[1].replace(/\./g, '').replace(',', '') : null

  } else if (source === 'google') {
    // Google score X.X / (X reviews)
    const m1 = text.match(/\b([1-5][,.]\d)\b[\s\S]{0,60}(?:recensioni|reviews|valutazioni)/i)
    const m2 = text.match(/(?:recensioni|reviews|valutazioni)[\s\S]{0,60}\b([1-5][,.]\d)\b/i)
    // "4.5 (1,234 reviews)"
    const m3 = text.match(/([1-5][,.]\d)\s*\(\s*([\d.,]+)\s*(?:recensioni|reviews)/i)
    const raw = m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? null
    rating = raw ? cleanNum(raw) : null

    const mn = m3 ? m3[2] : text.match(/([\d.,]+)\s*(?:recensioni|reviews|valutazioni)/i)?.[1]
    nRec = mn ? mn.replace(/\./g, '').replace(',', '') : null
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

    // Anti-bot detection
    const lower = text.toLowerCase()
    if (text.length < 600 && (lower.includes('captcha') || lower.includes('verify you are human') || lower.includes('access denied'))) {
      return new Response(JSON.stringify({ error: 'blocked', message: 'Portale ha bloccato la scansione' }), { headers: cors })
    }

    const { rating, n_recensioni } = extractRating(text, source)

    return new Response(JSON.stringify({ ok: true, rating, n_recensioni, method }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
