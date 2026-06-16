import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const DEST_EMAIL   = 'mario@in3pida.it';
const SB_URL       = Deno.env.get('SUPABASE_URL')!;
const SB_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

  // Save to DB always
  await sb.from('isi_feedback').insert({ message: message.trim(), reply_to: reply_to || null, sent_by_email: false });

  // Try email if key is present
  let emailSent = false;
  if (RESEND_KEY) {
    const emailPayload: Record<string, unknown> = {
      from: 'Eletta Feedback <noreply@isi.in3pida.it>',
      to: [DEST_EMAIL],
      subject: `Feedback albergatore${reply_to ? ' — ' + reply_to : ''}`,
      text: message.trim() + (reply_to ? '\n\n— ' + reply_to : ''),
    };
    if (reply_to) emailPayload.reply_to = reply_to;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });
    if (res.ok) {
      emailSent = true;
      await sb.from('isi_feedback').update({ sent_by_email: true }).order('created_at', { ascending: false }).limit(1);
    }
  }

  return new Response(JSON.stringify({ ok: true, saved: true, emailed: emailSent }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
