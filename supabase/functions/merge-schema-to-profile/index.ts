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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

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
