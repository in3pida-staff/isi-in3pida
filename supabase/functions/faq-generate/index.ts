import { reportAiStatus } from '../_shared/alerts.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FAQ_ALERT = (ok: boolean) => reportAiStatus(SUPABASE_URL, SERVICE_KEY, 'faq:generate', ok, 'Generazione risposte FAQ', { source: 'faq-generate', model: 'claude-haiku-4-5' });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { site_id, query } = await req.json();
    if (!site_id || !query) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: cors });

    // Fetch hotel data
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(site_id)}&select=hotel_profile,schema_data,site_name`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    const [site] = await sbRes.json();
    if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404, headers: cors });

    const hp = site.hotel_profile || {};
    const sc = site.schema_data   || {};

    const nomeHotel = sc.name || hp.nome_hotel || hp.nome || site.site_name || '';
    const lines = [
      nomeHotel                                          ? `Hotel: ${nomeHotel}` : '',
      sc.starRating?.ratingValue || hp.stelle            ? `Stelle: ${sc.starRating?.ratingValue || hp.stelle}` : '',
      sc.address?.streetAddress  || hp.indirizzo         ? `Indirizzo: ${sc.address?.streetAddress || hp.indirizzo}` : '',
      sc.telephone || hp.telefono                        ? `Telefono: ${sc.telephone || hp.telefono}` : '',
      sc.email     || hp.email                           ? `Email: ${sc.email || hp.email}` : '',
      sc.checkinTime  || hp.check_in                     ? `Check-in: ${sc.checkinTime || hp.check_in}` : '',
      sc.checkoutTime || hp.check_out                    ? `Check-out: ${sc.checkoutTime || hp.check_out}` : '',
      sc.description  || hp.descrizione                  ? `Descrizione: ${sc.description || hp.descrizione}` : '',
      (sc.amenityFeature?.map((a: any) => a.name||a).join(', ') || hp.servizi)
                                                         ? `Servizi: ${sc.amenityFeature?.map((a: any) => a.name||a).join(', ') || hp.servizi}` : '',
    ].filter(Boolean).join('\n');

    if (!lines.trim()) {
      return new Response(JSON.stringify({ error: 'no_data' }), { status: 422, headers: cors });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'Sei l\'assistente virtuale di un hotel italiano. Rispondi in italiano in modo diretto, preciso e professionale (2-4 frasi). Usa SOLO le informazioni fornite. Non inventare nulla.',
        messages: [{ role: 'user', content: `Informazioni hotel:\n${lines}\n\nDomanda del cliente: ${query}\n\nRisposta:` }]
      })
    });

    const data = await res.json();
    const answer = data.content?.[0]?.text?.trim() ?? '';
    if (!answer) { await FAQ_ALERT(false); return new Response(JSON.stringify({ error: 'empty_response' }), { status: 500, headers: cors }); }

    await FAQ_ALERT(true);
    return new Response(JSON.stringify({ answer }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    await FAQ_ALERT(false);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
