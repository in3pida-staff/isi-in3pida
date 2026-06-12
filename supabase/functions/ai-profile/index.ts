import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')              ?? ''
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url    = new URL(req.url)
  const siteId = url.searchParams.get('site_id')

  if (!siteId) return new Response(
    JSON.stringify({ error: 'Missing site_id' }),
    { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
  )

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
  const { data: site } = await sb
    .from('isi_sites')
    .select('site_id, site_name, site_url, hotel_profile, schema_data, faq_data')
    .eq('site_id', siteId)
    .single()

  if (!site) return new Response(
    JSON.stringify({ error: 'Not found' }),
    { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } }
  )

  // Kill switch — disattivabile dal dashboard ISI
  if (site.hotel_profile?.ai_layer_disabled === true) return new Response(
    JSON.stringify({ error: 'AI Layer disabled for this site' }),
    { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } }
  )

  const sd = site.schema_data   || {}
  const hp = site.hotel_profile || {}
  const faqData = site.faq_data || {}

  const profile: any = {
    '@context': 'https://schema.org',
    '@type': sd.type || hp.tipo_struttura || 'Hotel',
    name: sd.name || hp.nome_hotel || hp.nome || site.site_name,
    url:  sd.url  || hp.sito_web   || site.site_url,
  }

  if (sd.description || hp.descrizione)
    profile.description = sd.description || hp.descrizione
  if (sd.telephone || hp.telefono)
    profile.telephone = sd.telephone || hp.telefono
  if (sd.email || hp.email)
    profile.email = sd.email || hp.email
  if (hp.prezzo_medio || sd.price_range)
    profile.priceRange = sd.price_range || hp.prezzo_medio

  if (sd.street || sd.city || hp.via || hp.citta) {
    profile.address = {
      '@type': 'PostalAddress',
      streetAddress:   sd.street      || hp.via     || '',
      addressLocality: sd.city        || hp.citta   || '',
      addressRegion:   sd.region      || hp.regione || '',
      postalCode:      sd.postal_code || hp.cap     || '',
      addressCountry:  sd.country     || hp.paese   || 'IT',
    }
  }

  if (sd.official_rating || hp.stelle)
    profile.starRating = { '@type': 'Rating', ratingValue: sd.official_rating || hp.stelle }
  if (sd.latitude && sd.longitude)
    profile.geo = { '@type': 'GeoCoordinates', latitude: sd.latitude, longitude: sd.longitude }
  if (sd.checkin_time  || hp.checkin_dalle)
    profile.checkinTime  = sd.checkin_time  || hp.checkin_dalle
  if (sd.checkout_time || hp.checkout_dalle)
    profile.checkoutTime = sd.checkout_time || hp.checkout_dalle

  if (hp.servizi) {
    profile.amenityFeature = String(hp.servizi)
      .split(',')
      .map((s: string) => ({ '@type': 'LocationFeatureSpecification', name: s.trim() }))
      .filter((f: any) => f.name)
  }

  // FAQ
  const faqItems = (faqData.items || []).filter((i: any) =>
    i.status === 'publish' || i.status === 'published' || (!i.status && i.solo_ai !== true)
  )
  if (faqItems.length) {
    profile.hasOfferCatalog = {
      '@type': 'OfferCatalog',
      name: 'FAQ',
      itemListElement: faqItems.map((i: any) => ({
        '@type': 'Question',
        name: i.question,
        acceptedAnswer: { '@type': 'Answer', text: i.answer },
      })),
    }
  }

  return new Response(JSON.stringify(profile, null, 2), {
    headers: {
      ...cors,
      'Content-Type':  'application/ld+json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
})
