import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY             = Deno.env.get('SUPABASE_ANON_KEY')!;
const OPENAI_API_KEY       = Deno.env.get('OPENAI_API_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function isAuthorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!bearer) return false;
  if (bearer === SUPABASE_SERVICE_KEY) return true;
  const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(bearer);
  return !!user;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
  });
  const data = await res.json();
  if (!data.data?.[0]?.embedding) throw new Error('OpenAI embedding error');
  return data.data[0].embedding;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!(await isAuthorized(req))) {
    return new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { site_id } = await req.json();
    if (!site_id) return new Response(JSON.stringify({ error: 'site_id richiesto' }), { status: 400, headers: cors });

    const [{ data: embeddings }, { data: tests }, { data: site }] = await Promise.all([
      admin.from('isi_chunk_embeddings').select('chunk_id,chunk_title,chunk_type,embedding').eq('site_id', site_id),
      admin.from('isi_benchmark_tests').select('query,expected_chunk_id').eq('site_id', site_id),
      admin.from('isi_sites').select('site_name').eq('site_id', site_id).single(),
    ]);

    if (!embeddings?.length) {
      return new Response(JSON.stringify({ error: 'Nessun embedding. Esegui prima Setup Benchmark.' }), { status: 400, headers: cors });
    }
    if (!tests?.length) {
      return new Response(JSON.stringify({ error: 'Nessun test. Esegui prima Setup Benchmark.' }), { status: 400, headers: cors });
    }

    const results = [];
    let passed1 = 0, passed3 = 0, rrSum = 0;
    const t0 = Date.now();

    for (const test of tests) {
      const tq = Date.now();
      const queryVec = await embed(test.query);

      const ranked = (embeddings as any[])
        .map(e => ({
          chunk_id:    e.chunk_id,
          chunk_title: e.chunk_title,
          chunk_type:  e.chunk_type,
          similarity:  cosineSimilarity(queryVec, e.embedding as number[]),
        }))
        .sort((a, b) => b.similarity - a.similarity);

      const rank = ranked.findIndex(r => r.chunk_id === test.expected_chunk_id) + 1;

      if (rank === 1) passed1++;
      if (rank >= 1 && rank <= 3) passed3++;
      if (rank >= 1) rrSum += 1 / rank;

      results.push({
        query:             test.query,
        expected_chunk_id: test.expected_chunk_id,
        expected_title:    (embeddings as any[]).find(e => e.chunk_id === test.expected_chunk_id)?.chunk_title ?? '?',
        rank:              rank || null,
        similarity:        rank ? ranked[rank - 1].similarity : null,
        passed_1:          rank === 1,
        passed_3:          rank >= 1 && rank <= 3,
        top_chunk:         ranked[0],
        latency_ms:        Date.now() - tq,
      });
    }

    const total      = tests.length;
    const precision1 = parseFloat(((passed1 / total) * 100).toFixed(1));
    const precision3 = parseFloat(((passed3 / total) * 100).toFixed(1));
    const mrr        = parseFloat((rrSum / total).toFixed(3));

    await admin.from('isi_benchmark_runs').insert({
      site_id,
      site_name:    site?.site_name ?? '',
      precision_1:  precision1,
      precision_3:  precision3,
      mrr,
      total_queries: total,
      passed_1:     passed1,
      results,
    });

    return new Response(JSON.stringify({
      ok: true,
      summary: { precision_1: precision1, precision_3: precision3, mrr, total_queries: total, passed_1: passed1, passed_3: passed3, total_ms: Date.now() - t0 },
      results,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
