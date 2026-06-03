import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY             = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY    = Deno.env.get('ANTHROPIC_API_KEY')!;
const GEMINI_API_KEY       = Deno.env.get('GEMINI_API_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Accetta sia JWT utente (dashboard) sia service key (plugin WP)
async function isAuthorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!bearer) return false;
  // Service key diretta (chiamata da plugin WP)
  if (bearer === SUPABASE_SERVICE_KEY) return true;
  // JWT utente (chiamata da dashboard ISI)
  const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(bearer);
  return !!user;
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: text.slice(0, 8000) }] },
      }),
    }
  );
  const data = await res.json();
  if (!data.embedding?.values) throw new Error('Gemini embedding error: ' + JSON.stringify(data).slice(0, 200));
  return data.embedding.values;
}

async function generateQuestions(chunkTitle: string, chunkContent: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `Sei un assistente che genera domande naturali in italiano per testare un sistema di retrieval.
Dato un blocco di informazioni su una struttura ricettiva, genera esattamente 3 domande naturali a cui quel blocco risponde direttamente.
Le domande devono essere quelle di un ospite reale: brevi, concrete, in italiano.
Rispondi SOLO con un array JSON di 3 stringhe, nessun testo extra.`,
      messages: [{
        role: 'user',
        content: `Titolo: ${chunkTitle}\nContenuto: ${chunkContent.slice(0, 500)}`,
      }],
    }),
  });
  const data = await res.json();
  try { return JSON.parse(data.content?.[0]?.text ?? '[]'); } catch { return []; }
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
    const { site_id, chunks } = await req.json();
    if (!site_id || !chunks?.length) {
      return new Response(JSON.stringify({ error: 'site_id e chunks richiesti' }), { status: 400, headers: cors });
    }

    const { data: site } = await admin.from('isi_sites').select('site_name').eq('site_id', site_id).single();
    if (!site) return new Response(JSON.stringify({ error: 'Sito non trovato' }), { status: 404, headers: cors });

    // Pulisci test suite precedente
    await admin.from('isi_benchmark_tests').delete().eq('site_id', site_id);

    let chunksEmbedded = 0, testsGenerated = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      const chunkId    = String(chunk.id ?? chunk.type ?? chunksEmbedded);
      const chunkTitle = String(chunk.title ?? '');
      const content    = String(chunk.content ?? '');
      if (!content.trim()) continue;

      try {
        const embedding = await embed(`${chunkTitle}: ${content}`);

        await admin.from('isi_chunk_embeddings').upsert({
          site_id,
          chunk_id:      chunkId,
          chunk_type:    chunk.type ?? '',
          chunk_title:   chunkTitle,
          chunk_content: content.slice(0, 1000),
          embedding,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'site_id,chunk_id' });

        chunksEmbedded++;

        const questions = await generateQuestions(chunkTitle, content);
        for (const q of questions) {
          if (q?.trim()) {
            await admin.from('isi_benchmark_tests').insert({
              site_id, query: q.trim(), expected_chunk_id: chunkId,
            });
            testsGenerated++;
          }
        }
      } catch (e) {
        errors.push(`"${chunkTitle}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return new Response(JSON.stringify({
      ok: true, site_name: site.site_name, chunks_embedded: chunksEmbedded, tests_generated: testsGenerated, errors,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
