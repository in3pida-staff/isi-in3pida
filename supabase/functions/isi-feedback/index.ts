import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GH_TOKEN = Deno.env.get('GITHUB_TOKEN') || '';
const GH_REPO  = 'in3pida-staff/isi-in3pida';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Solo utenti loggati (o chiamate server). Blocca il pubblico/anon (anti-spam).
  const _p = ((req.headers.get('Authorization')||'').replace('Bearer ','').split('.')[1]||'').replace(/-/g,'+').replace(/_/g,'/');
  let _role=''; try { _role = JSON.parse(atob(_p + '='.repeat((4-_p.length%4)%4))).role||'' } catch(_) {}
  if (_role !== 'authenticated' && _role !== 'service_role') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

  const { message, reply_to, site_name } = await req.json().catch(() => ({}));
  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Messaggio vuoto' }), { status: 400, headers: cors });
  }

  const sb = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await sb.from('isi_feedback').insert({ message: message.trim(), reply_to: reply_to || null, sent_by_email: false });

  let emailSent = false;
  if (GH_TOKEN) {
    try {
      const hotelName = (site_name || '').trim() || 'Hotel';
      const title = `Feedback da piattaforma Eletta - ${hotelName}`;
      const body = message.trim() + (reply_to ? `\n\n**Da:** ${reply_to}` : '');
      const res = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GH_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify({ title, body, labels: ['feedback'] }),
      });
      if (res.ok) {
        emailSent = true;
        await sb.from('isi_feedback').update({ sent_by_email: true }).order('created_at', { ascending: false }).limit(1);
      }
    } catch (err) {
      console.error('GitHub issue error:', err);
    }
  }

  return new Response(JSON.stringify({ ok: true, saved: true, emailed: emailSent }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
