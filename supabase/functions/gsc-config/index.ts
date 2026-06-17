const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const clientId = Deno.env.get('GOOGLE_GSC_CLIENT_ID') || ''
  return new Response(JSON.stringify({ clientId }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
