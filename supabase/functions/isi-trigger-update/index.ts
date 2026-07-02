import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Auth: acepta service role key (cualquier formato) o JWT de usuario válido
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // Verifica se è un JWT utente valido
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user } } = await anonClient.auth.getUser(token);
  // Verifica se è la service role key (sia vecchio JWT che nuovo sb_secret_*)
  let isAdmin = false;
  if (user) {
    isAdmin = true;
  } else {
    // Tenta verifica admin: crea client con il token ricevuto e verifica accesso
    try {
      const testClient = createClient(SUPABASE_URL, token, { auth: { autoRefreshToken: false, persistSession: false } });
      const { error: testErr } = await testClient.from('isi_sites').select('site_id').limit(1);
      if (!testErr) isAdmin = true;
    } catch (_) { /* non è un service key */ }
  }
  if (!isAdmin) {
    return new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401, headers: cors });
  }

  const body = await req.json();
  const { site_id, all, action } = body;

  // ── RELEASE: pubblica nuova versione corrente ──────────────────────────────
  if (action === 'release') {
    const { version, download_url, changelog } = body;
    if (!version || !download_url) {
      return new Response(JSON.stringify({ error: 'version e download_url obbligatori' }), { status: 400, headers: cors });
    }
    // 1. Azzera is_current su tutte le righe
    await admin.from('isi_plugin_versions').update({ is_current: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    // 2. Inserisci la nuova versione
    const { data: inserted } = await admin.from('isi_plugin_versions')
      .insert({ version, download_url, changelog: changelog || null, is_current: false, released_at: new Date().toISOString() })
      .select('id').single();
    // 3. Forza is_current=true per id (bypassa trigger)
    if (inserted?.id) {
      await admin.from('isi_plugin_versions').update({ is_current: true }).eq('id', inserted.id);
    }
    // 4. Verifica
    const { data: check } = await admin.from('isi_plugin_versions').select('version,is_current').eq('is_current', true).single();
    return new Response(JSON.stringify({ ok: true, current: check }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // Fetch current plugin version + download URL (versione più recente per released_at)
  const { data: verData, error: verErr } = await admin
    .from('isi_plugin_versions')
    .select('version, download_url')
    .order('released_at', { ascending: false })
    .limit(1)
    .single();

  if (verErr || !verData?.download_url) {
    return new Response(
      JSON.stringify({ error: 'Nessuna versione corrente in isi_plugin_versions. Aggiungi una riga con is_current=true e download_url.' }),
      { status: 400, headers: cors }
    );
  }

  // Fetch target sites
  let sitesQuery = admin.from('isi_sites').select('site_id, site_url, site_name, plugin_version');
  if (!all && site_id) sitesQuery = sitesQuery.eq('site_id', site_id);
  const { data: sites, error: sitesErr } = await sitesQuery;

  if (sitesErr || !sites?.length) {
    return new Response(JSON.stringify({ error: sitesErr?.message || 'Nessun sito trovato' }), { status: 404, headers: cors });
  }

  // Call each WP site's REST endpoint
  const results = await Promise.all(sites.map(async (site) => {
    const siteUrl = (site.site_url || '').replace(/\/$/, '');
    try {
      const res = await fetch(`${siteUrl}/wp-json/in3pida/v1/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret:       site.site_id,
          download_url: verData.download_url,
          version:      verData.version,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const body = await res.json().catch(() => ({}));
      const resolvedVersion = body.skipped ? (body.current || verData.version) : verData.version;
      // Aggiorna plugin_version in Supabase con la versione reale
      if (res.ok) {
        await admin.from('isi_sites').update({ plugin_version: resolvedVersion }).eq('site_id', site.site_id);
      }
      return {
        site_id:   site.site_id,
        site_name: site.site_name,
        ok:        res.ok,
        status:    res.status,
        skipped:   body.skipped ?? false,
        message:   body.error || body.message || (body.skipped ? `Già alla v${resolvedVersion}` : `Aggiornato a v${verData.version}`),
      };
    } catch (e) {
      return {
        site_id:   site.site_id,
        site_name: site.site_name,
        ok:        false,
        error:     e instanceof Error ? e.message : String(e),
      };
    }
  }));

  return new Response(
    JSON.stringify({ results, version: verData.version }),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  );
});
