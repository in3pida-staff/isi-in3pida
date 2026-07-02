import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

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

async function fetchPage(url: string): Promise<{ text: string; method: string }> {
  // Tentativo diretto
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
    if (text.length > 400) return { text, method: `direct HTTP ${res.status}` }
  } catch (_) { /* fallback */ }

  // Fallback Jina.ai
  const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '15' },
    signal: AbortSignal.timeout(20000),
  })
  if (!jinaRes.ok) throw new Error(`Jina HTTP ${jinaRes.status}`)
  const text = (await jinaRes.text()).slice(0, 12000)
  if (text.length < 200) throw new Error(`Contenuto troppo breve (${text.length} chars)`)
  return { text, method: 'jina' }
}

function norm(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function normPhone(s: string): string {
  return s.replace(/\D/g,'').replace(/^39/,'')
}

function normTime(s: string): string {
  const m = s.match(/(\d{1,2})[:\.\s](\d{2})/)
  if (m) return m[1].padStart(2,'0') + ':' + m[2]
  const h = s.match(/(\d{1,2})\s*h/i)
  if (h) return h[1].padStart(2,'0') + ':00'
  return s.replace(/\D/g,'').slice(0,4)
}

function fuzzyMatch(our: string, found: string): boolean {
  if (!our || !found) return false
  const a = norm(our), b = norm(found)
  // Corrispondenza esatta o contenuta
  if (a === b) return true
  if (b.includes(a) || a.includes(b)) return true
  // Parole chiave: almeno 2/3 delle parole principali dell'hotel si trovano nel testo
  const words = a.split(' ').filter(w => w.length > 3)
  if (!words.length) return false
  const matched = words.filter(w => b.includes(w))
  return matched.length >= Math.ceil(words.length * 0.65)
}

function extractResults(
  text: string,
  refData: Record<string, string>
): Array<{ field: string; our_value: string; found_value: string | null; match: boolean }> {
  const t = text
  const results = []

  // ── Nome struttura ────────────────────────────────────────
  const ourName = refData['Nome struttura']
  const normText = norm(t)
  const nameFound = ourName && normText.includes(norm(ourName)) ? ourName : null
  results.push({ field: 'Nome struttura', our_value: ourName, found_value: nameFound, match: fuzzyMatch(ourName, t) })

  // ── Stelle ───────────────────────────────────────────────
  const ourStars = refData['Stelle']
  let foundStars: string | null = null
  const starM = t.match(/(\d)\s*stelle|(\d)\s*star|(\d)\s*\*{1}[^*]|\b(\d)\s*★/i)
  if (starM) foundStars = (starM[1]||starM[2]||starM[3]||starM[4])
  const starsSymbol = t.match(/★{2,5}/)
  if (!foundStars && starsSymbol) foundStars = String(starsSymbol[0].length)
  results.push({ field: 'Stelle', our_value: ourStars, found_value: foundStars, match: !!foundStars && foundStars === ourStars })

  // ── Indirizzo ────────────────────────────────────────────
  const ourAddr = refData['Indirizzo']
  let addrMatch = false
  if (ourAddr) {
    const parts = ourAddr.split(',').map(p => norm(p.trim())).filter(p => p.length > 2)
    const matched = parts.filter(p => normText.includes(p))
    addrMatch = matched.length >= Math.ceil(parts.length * 0.5)
  }
  results.push({ field: 'Indirizzo', our_value: ourAddr, found_value: addrMatch ? ourAddr : null, match: addrMatch })

  // ── Telefono ─────────────────────────────────────────────
  const ourPhone = refData['Telefono']
  const phoneMatches = [...t.matchAll(/(?:\+39\s?)?(?:0\d{1,4}[\s\-\/]?\d{3,8}[\s\-\/]?\d{0,8}|\d{3}[\s\-\/]?\d{3}[\s\-\/]?\d{4})/g)]
  let foundPhone: string | null = null
  let phoneMatch = false
  if (phoneMatches.length) {
    foundPhone = phoneMatches[0][0].trim()
    phoneMatch = ourPhone ? normPhone(ourPhone) === normPhone(foundPhone) : false
  }
  results.push({ field: 'Telefono', our_value: ourPhone, found_value: foundPhone, match: phoneMatch })

  // ── Email ────────────────────────────────────────────────
  const ourEmail = refData['Email']
  const emailM = t.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
  const foundEmail = emailM ? emailM[0] : null
  results.push({ field: 'Email', our_value: ourEmail, found_value: foundEmail, match: !!ourEmail && !!foundEmail && ourEmail.toLowerCase() === foundEmail.toLowerCase() })

  // ── Check-in ─────────────────────────────────────────────
  const ourCin = refData['Check-in']
  const cinM = t.match(/check.?in[^:]*?[:\s]+(?:dalle?\s*)?(\d{1,2}[:\.\s]\d{2}|\d{1,2}\s*h)/i) ||
               t.match(/arrivo[^:]*?[:\s]+(?:dalle?\s*)?(\d{1,2}[:\.\s]\d{2}|\d{1,2}\s*h)/i) ||
               t.match(/(?:a partire|dalle?)\s*(?:ore\s*)?(\d{1,2}[:\.\s]\d{2}|\d{1,2}\s*h)(?:[^\n]*check)/i)
  const foundCin = cinM ? cinM[1].trim() : null
  const cinMatch = ourCin && foundCin ? normTime(ourCin) === normTime(foundCin) : false
  results.push({ field: 'Check-in', our_value: ourCin, found_value: foundCin, match: cinMatch })

  // ── Check-out ────────────────────────────────────────────
  const ourCout = refData['Check-out']
  const coutM = t.match(/check.?out[^:]*?[:\s]+(?:entro\s*|fino alle?\s*)?(\d{1,2}[:\.\s]\d{2}|\d{1,2}\s*h)/i) ||
                t.match(/partenza[^:]*?[:\s]+(?:entro\s*)?(\d{1,2}[:\.\s]\d{2}|\d{1,2}\s*h)/i)
  const foundCout = coutM ? coutM[1].trim() : null
  const coutMatch = ourCout && foundCout ? normTime(ourCout) === normTime(foundCout) : false
  results.push({ field: 'Check-out', our_value: ourCout, found_value: foundCout, match: coutMatch })

  // ── Sito web ─────────────────────────────────────────────
  const ourWeb = refData['Sito web']
  let webFound: string | null = null
  let webMatch = false
  if (ourWeb) {
    try {
      const domain = new URL(ourWeb).hostname.replace(/^www\./,'')
      if (t.includes(domain)) { webFound = ourWeb; webMatch = true }
    } catch (_) { /* invalid url */ }
  }
  results.push({ field: 'Sito web', our_value: ourWeb, found_value: webFound, match: webMatch })

  return results
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { site_id, channel, url } = await req.json()
    if (!site_id || !channel || !url)
      return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: site } = await supabase
      .from('isi_sites').select('hotel_profile, schema_data, site_name').eq('site_id', site_id).single()

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

    let pageText = ''
    let fetchMethod = ''

    try {
      const { text, method } = await fetchPage(url)
      pageText = text; fetchMethod = method
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'fetch_failed',
        message: `Impossibile leggere la pagina: ${(e as Error).message}`,
      }), { headers: cors })
    }

    // Rilevamento blocco anti-bot
    const lower = pageText.toLowerCase()
    if (pageText.length < 600 &&
        (lower.includes('captcha') || lower.includes('verify you are human') ||
         lower.includes('access denied') || lower.includes('cloudflare'))) {
      return new Response(JSON.stringify({
        error: 'blocked',
        message: 'Il portale ha bloccato la scansione (protezione anti-bot).',
      }), { headers: cors })
    }

    const results = extractResults(pageText, refData)

    return new Response(JSON.stringify({ ok: true, results, fetchMethod }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'exception', message: String(e) }), { status: 500, headers: cors })
  }
})
