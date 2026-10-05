// Merge chirurgico: schema_data (WP) → hotel_profile (Eletta)
// Regola: WP non vuoto → usa WP. WP vuoto/assente → tieni Eletta. Mai toccare campi solo-Eletta.

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

// Mappa: campo schema_data (WP) → campo hotel_profile (Eletta)
const FIELD_MAP: Record<string, string> = {
  name:               'nome_hotel',
  type:               'tipo_struttura',
  description:        'descrizione',
  url:                'sito_web',
  telephone:          'telefono',
  email:              'email',
  street:             'via',
  city:               'citta',
  region:             'regione',
  postal_code:        'cap',
  country:            'paese',
  official_rating:    'stelle',
  price_range:        'prezzo_medio',
  checkin_time:       'checkin_dalle',
  checkout_time:      'checkout_dalle',
  nearby_attractions: 'attrazioni_vicine',
  keywords:           'keywords_semantiche',
  latitude:           'latitudine',
  longitude:          'longitudine',
}

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

// Merge array offerte: matching per url o nome; preserva campi Eletta-only; aggiunge voci WP nuove; mantiene voci Eletta non presenti in WP
function mergeOfferte(
  wpOffers: Array<Record<string, string>>,
  elOfferte: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const wpUrls  = new Set(wpOffers.map(o => o.url).filter(Boolean))
  const wpNames = new Set(wpOffers.map(o => o.name).filter(Boolean))

  // Mappa le voci WP (con match se esiste già in Eletta)
  const mapped = wpOffers.map(wpOffer => {
    const existing = elOfferte.find(e =>
      (wpOffer.url  && e.url   === wpOffer.url) ||
      (wpOffer.name && e.nome  === wpOffer.name)
    ) as Record<string, unknown> | undefined

    return {
      // Campi Eletta-only: preserva se già presenti, altrimenti default
      tipo:        existing?.tipo        ?? 'Early Booking',
      sconto:      existing?.sconto      ?? '',
      data_inizio: existing?.data_inizio ?? '',
      data_fine:   existing?.data_fine   ?? '',
      condizioni:  existing?.condizioni  ?? '',
      // Campi WP (WP vince se non vuoto, altrimenti tieni Eletta)
      nome:     wpOffer.name        || (existing?.nome as string)       || '',
      descrizione: wpOffer.description || (existing?.descrizione as string) || '',
      prezzo_da:   wpOffer.price       || (existing?.prezzo_da as string)   || '',
      url:         wpOffer.url         || (existing?.url as string)         || '',
    }
  })

  // Mantieni voci Eletta non presenti in WP (non sovrascriverle)
  const elOnly = elOfferte.filter(e =>
    !(e.url  && wpUrls.has(e.url  as string)) &&
    !(e.nome && wpNames.has(e.nome as string))
  )

  return [...mapped, ...elOnly]
}

// Merge array camere: matching per url o nome; preserva campi Eletta-only; aggiunge voci WP nuove; mantiene voci Eletta non presenti in WP
function mergeCamere(
  wpRooms: Array<Record<string, unknown>>,
  elCamere: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const wpUrls  = new Set(wpRooms.map(r => r.url  as string).filter(Boolean))
  const wpNames = new Set(wpRooms.map(r => r.name as string).filter(Boolean))

  const mapped = wpRooms.map(wpRoom => {
    const existing = elCamere.find(e =>
      (wpRoom.url  && e.url   === wpRoom.url) ||
      (wpRoom.name && e.nome  === wpRoom.name)
    ) as Record<string, unknown> | undefined

    // amenities (array) → servizi (comma-join)
    const wpAmenities = wpRoom.amenities
    const serviziWP = Array.isArray(wpAmenities) && wpAmenities.length > 0
      ? (wpAmenities as string[]).join(', ')
      : ''

    return {
      // Campi Eletta-only: preserva se già presenti, altrimenti default
      n_camere: existing?.n_camere ?? '',
      // Campi WP (WP vince se non vuoto, altrimenti tieni Eletta)
      nome:         (wpRoom.name        as string) || (existing?.nome        as string) || '',
      url:          (wpRoom.url         as string) || (existing?.url         as string) || '',
      descrizione:  (wpRoom.description as string) || (existing?.descrizione as string) || '',
      n_max:        wpRoom.max                      ?? existing?.n_max        ?? '',
      tipo_letto:   (wpRoom.bed         as string) || (existing?.tipo_letto  as string) || '',
      prezzo_da:    (wpRoom.price       as string) || (existing?.prezzo_da   as string) || '',
      valuta:       (wpRoom.currency    as string) || (existing?.valuta      as string) || 'EUR',
      disponibilita:(wpRoom.availability as string) || (existing?.disponibilita as string) || '',
      vista:        (wpRoom.view        as string) || (existing?.vista       as string) || '',
      servizi:      serviziWP                       || (existing?.servizi    as string) || '',
    }
  })

  // Mantieni voci Eletta non presenti in WP
  const elOnly = elCamere.filter(e =>
    !(e.url  && wpUrls.has(e.url  as string)) &&
    !(e.nome && wpNames.has(e.nome as string))
  )

  return [...mapped, ...elOnly]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  // NOTA: richiamata dal plugin WordPress con la chiave pubblica (anon) durante l'heartbeat
  // per sincronizzare schema→profilo. NON mettere qui un guard "solo service_role": romperebbe il plugin.

  try {
    const body = await req.json()
    const { site_id, dry_run } = body

    if (!site_id) return new Response(JSON.stringify({ error: 'site_id obbligatorio' }), { status: 400, headers: cors })

    // Legge dati freschi da Supabase
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(site_id)}&select=site_id,schema_data,hotel_profile`,
      { headers: sbHeaders }
    )
    const rows = await res.json()
    if (!Array.isArray(rows) || !rows[0]) {
      return new Response(JSON.stringify({ error: 'sito non trovato' }), { status: 404, headers: cors })
    }

    const row         = rows[0]
    const schema      = (row.schema_data   || {}) as Record<string, unknown>
    const profile     = (row.hotel_profile || {}) as Record<string, unknown>

    // Accetta solo heartbeat provenienti dal plugin WP
    if (schema['_source'] !== 'plugin') {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'source non plugin' }), { headers: cors })
    }

    const changes: { field_eletta: string; old_value: unknown; new_value: unknown }[] = []
    const merged = { ...profile }

    // Merge campi base (stringa → stringa)
    for (const [wpField, elField] of Object.entries(FIELD_MAP)) {
      const wpVal = schema[wpField]
      if (isNonEmpty(wpVal) && wpVal !== profile[elField]) {
        changes.push({ field_eletta: elField, old_value: profile[elField], new_value: wpVal })
        merged[elField] = wpVal
      }
    }

    // Merge amenities: array WP → stringa Eletta (campo "servizi")
    const wpAmenities = schema['amenities']
    if (Array.isArray(wpAmenities) && wpAmenities.length > 0) {
      const elServizi = (wpAmenities as string[]).join(', ')
      if (elServizi !== profile['servizi']) {
        changes.push({ field_eletta: 'servizi', old_value: profile['servizi'], new_value: elServizi })
        merged['servizi'] = elServizi
      }
    }

    // Languages: stringa WP → stringa Eletta (campo "lingue_parlate")
    const wpLang = schema['languages']
    if (isNonEmpty(wpLang) && wpLang !== profile['lingue_parlate']) {
      changes.push({ field_eletta: 'lingue_parlate', old_value: profile['lingue_parlate'], new_value: wpLang })
      merged['lingue_parlate'] = wpLang as string
    }

    // Merge offerte (array)
    const wpOffers = schema['offers'] as Array<Record<string, string>> | undefined
    if (Array.isArray(wpOffers) && wpOffers.length > 0) {
      const elOfferte = (profile['offerte'] as Array<Record<string, unknown>>) || []
      const newOfferte = mergeOfferte(wpOffers, elOfferte)
      if (JSON.stringify(newOfferte) !== JSON.stringify(elOfferte)) {
        changes.push({ field_eletta: 'offerte', old_value: elOfferte, new_value: newOfferte })
        merged['offerte'] = newOfferte
      }
    }

    // Merge camere (array)
    const wpRooms = schema['rooms'] as Array<Record<string, unknown>> | undefined
    if (Array.isArray(wpRooms) && wpRooms.length > 0) {
      const elCamere = (profile['camere'] as Array<Record<string, unknown>>) || []
      const newCamere = mergeCamere(wpRooms, elCamere)
      if (JSON.stringify(newCamere) !== JSON.stringify(elCamere)) {
        changes.push({ field_eletta: 'camere', old_value: elCamere, new_value: newCamere })
        merged['camere'] = newCamere
      }
    }

    // Nessuna modifica necessaria
    if (changes.length === 0) {
      return new Response(JSON.stringify({ ok: true, changes: 0 }), { headers: cors })
    }

    // Dry run: mostra cosa cambierebbe senza scrivere nulla
    if (dry_run) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, changes }), { headers: cors })
    }

    // Scrittura su Supabase
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(site_id)}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ hotel_profile: merged }),
      }
    )

    if (!patch.ok) {
      return new Response(JSON.stringify({ error: 'patch fallita', status: patch.status }), { status: 500, headers: cors })
    }

    return new Response(JSON.stringify({ ok: true, changes: changes.length, detail: changes }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors })
  }
})
