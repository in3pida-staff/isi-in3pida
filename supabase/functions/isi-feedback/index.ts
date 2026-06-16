const RESEND_KEY  = Deno.env.get('RESEND_API_KEY') ?? '';
const DEST_EMAIL  = 'mario@in3pida.it';

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

  const emailPayload: Record<string, unknown> = {
    from: 'Eletta Feedback <noreply@isi.in3pida.it>',
    to: [DEST_EMAIL],
    subject: `Feedback albergatore${reply_to ? ' — ' + reply_to : ''}`,
    text: message + (reply_to ? '\n\n— ' + reply_to : ''),
  };
  if (reply_to) emailPayload.reply_to = reply_to;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ error: err }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
