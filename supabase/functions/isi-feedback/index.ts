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

  const { message, reply_to } = await req.json().catch(() => ({}));
  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Messaggio vuoto' }), { status: 400, headers: cors });
  }

  const sb = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await sb.from('isi_feedback').insert({ message: message.trim(), reply_to: reply_to || null, sent_by_email: false });

  let emailSent = false;
  if (GH_TOKEN) {
    try {
      const title = `Feedback albergatore${reply_to ? ' — ' + reply_to : ''}`;
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
