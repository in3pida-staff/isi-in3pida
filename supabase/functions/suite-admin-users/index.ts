// ════════════════════════════════════════════════════════════════════════
//  suite-admin-users — Edge Function
//
//  Espone la lista degli account Supabase Auth (id, email, ultimo accesso)
//  SOLO a mario@in3pida.it. La suite la usa per "Gestione utenti".
//
//  GET  → elenco account (sola lettura)
//  POST {action:'set-password', user_id, password} → assegna una nuova password
//  POST {action:'set-avatar',   user_id, image}    → carica la foto profilo
//  POST {action:'create-user',  email, password, full_name} → nuovo account
//        (se l'email esiste gia' NON tocca nulla e lo dice)
//        (NON crea e NON elimina account, e agisce solo su richiesta
//         esplicita dell'amministratore)
//
//  Deploy:  supabase functions deploy suite-admin-users
//  (Le variabili SUPABASE_URL / SERVICE_ROLE / ANON sono già nell'ambiente.)
// ════════════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const ADMIN_EMAIL      = 'mario@in3pida.it';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 1) chi sta chiamando?
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error: authErr } = await anon.auth.getUser(token);
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401, headers: cors });
  }

  // 2) DEVE essere l'admin — altrimenti niente
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: 'Accesso riservato all\'amministratore' }), { status: 403, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3) lettura della lista utenti
  if (req.method === 'GET') {
    const { data: { users }, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
    const slim = users.map(u => ({ id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at, user_metadata: u.user_metadata }));
    return new Response(JSON.stringify(slim), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // 4) assegnazione di una nuova password, su richiesta esplicita dell'admin
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    // creazione di un nuovo account
    if (body.action === 'create-user') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return new Response(JSON.stringify({ error: 'Email non valida' }), { status: 400, headers: cors });
      }
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return new Response(JSON.stringify({ error: 'Password troppo corta' }), { status: 400, headers: cors });
      }
      // se l'account esiste gia' non lo tocco in nessun modo
      const { data: esistenti } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const gia = (esistenti?.users || []).find((u) => (u.email || '').toLowerCase() === email);
      if (gia) {
        return new Response(JSON.stringify({ ok: true, esisteva: true, id: gia.id, email }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const meta: Record<string, unknown> = {};
      if (body.full_name) meta.full_name = String(body.full_name);
      const { data, error } = await admin.auth.admin.createUser({
        email, password: body.password, email_confirm: true, user_metadata: meta,
      });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
      return new Response(JSON.stringify({ ok: true, esisteva: false, id: data.user?.id, email }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (!body.user_id) {
      return new Response(JSON.stringify({ error: 'Utente non indicato' }), { status: 400, headers: cors });
    }

    // nuova password
    if (body.action === 'set-password') {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return new Response(JSON.stringify({ error: 'Dati non validi: servono almeno 8 caratteri' }), { status: 400, headers: cors });
      }
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // foto profilo: arriva gia' ridotta a 256px quadrati dal browser
    if (body.action === 'set-avatar') {
      const dati = String(body.image || '');
      const m = dati.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
      if (!m) return new Response(JSON.stringify({ error: 'Immagine non valida' }), { status: 400, headers: cors });
      if (m[2].length > 4_000_000) return new Response(JSON.stringify({ error: 'Immagine troppo pesante' }), { status: 400, headers: cors });
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const path = `${body.user_id}.jpg`;
      const { error: upErr } = await admin.storage.from('avatars')
        .upload(path, bytes, { upsert: true, contentType: 'image/jpeg' });
      if (upErr) return new Response(JSON.stringify({ error: 'Caricamento non riuscito: ' + upErr.message }), { status: 500, headers: cors });

      const base = admin.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      const avatar_url = `${base}?t=${Date.now()}`;
      // conservo il resto dei dati del profilo, cambio solo la foto
      const { data: attuale } = await admin.auth.admin.getUserById(body.user_id);
      const meta = { ...(attuale?.user?.user_metadata || {}), avatar_url };
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { user_metadata: meta });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
      return new Response(JSON.stringify({ ok: true, avatar_url }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Operazione non prevista' }), { status: 400, headers: cors });
  }

  return new Response(JSON.stringify({ error: 'Metodo non supportato' }), { status: 405, headers: cors });
});
