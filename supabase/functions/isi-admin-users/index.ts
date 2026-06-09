import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(token);
  if (authErr || !user) return new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401, headers: cors });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  if (req.method === 'GET') {
    const { data: { users }, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
    return new Response(JSON.stringify(users), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const { user_id, full_name, role, site_id, avatar_url, plugin_features, menu_visibility } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: 'user_id mancante' }), { status: 400, headers: cors });
    const meta: Record<string, unknown> = { full_name, role };
    if (site_id !== undefined) meta.site_id = site_id;
    if (avatar_url !== undefined) meta.avatar_url = avatar_url;
    if (plugin_features !== undefined) meta.plugin_features = plugin_features;
    if (menu_visibility !== undefined) meta.menu_visibility = menu_visibility;
    const { error } = await admin.auth.admin.updateUserById(user_id, { user_metadata: meta });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
    return new Response(JSON.stringify({ ok: true }), { headers: cors });
  }

  if (req.method === 'DELETE') {
    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: 'user_id mancante' }), { status: 400, headers: cors });
    if (user_id === user.id) return new Response(JSON.stringify({ error: 'Non puoi eliminare te stesso' }), { status: 400, headers: cors });
    const { error } = await admin.auth.admin.deleteUser(user_id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });
    return new Response(JSON.stringify({ ok: true }), { headers: cors });
  }

  return new Response(JSON.stringify({ error: 'Metodo non supportato' }), { status: 405, headers: cors });
});
