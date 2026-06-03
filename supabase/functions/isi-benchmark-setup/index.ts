import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY             = Deno.env.get('SUPABASE_ANON_KEY')!;

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

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\wàèéìíîòóùú\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function buildVocab(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    }
  }
  return vocab;
}

function tfidf(text: string, vocab: Map<string, number>, df: Map<string, number>, N: number): number[] {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Array(vocab.size).fill(0);
  for (const [term, count] of tf) {
    const idx = vocab.get(term);
    if (idx !== undefined) {
      const idf = Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
      vec[idx] = (count / tokens.length) * idf;
    }
  }
  return vec;
}

const TEMPLATES: Record<string, string[]> = {
  identity:  ['Chi è e cosa offre questa struttura?', 'Dove si trova l\'hotel e cosa lo distingue?', 'Che tipo di struttura è e quali sono i suoi punti di forza?'],
  contact:   ['Come posso contattare l\'hotel?', 'Dove si trova e come si raggiunge?', 'Qual è l\'indirizzo e il recapito telefonico?'],
  amenities: ['Quali servizi e dotazioni sono disponibili?', 'Cosa è incluso nella struttura?', 'Quali comfort offre l\'hotel agli ospiti?'],
  rooms:     ['Che tipo di camere sono disponibili?', 'Come sono le camere e cosa includono?', 'Quali sono le opzioni di alloggio?'],
  faq:       ['Quali sono le politiche principali dell\'hotel?', 'Informazioni su check-in, check-out e regole?', 'Cosa devo sapere prima di arrivare?'],
  default:   ['Puoi darmi informazioni su questo argomento?', 'Cosa posso trovare qui?', 'Quali dettagli sono disponibili?'],
};

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

    await admin.from('isi_benchmark_tests').delete().eq('site_id', site_id);

    const validChunks = chunks.filter((c: any) => String(c.content ?? '').trim().length > 0);
    const allTexts = validChunks.map((c: any) => `${c.title ?? ''} ${c.content ?? ''}`);
    const vocab = buildVocab(allTexts);

    // Compute document frequency
    const df = new Map<string, number>();
    for (const text of allTexts) {
      const seen = new Set(tokenize(text));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }

    let chunksEmbedded = 0, testsGenerated = 0;
    const errors: string[] = [];

    for (const chunk of validChunks) {
      const chunkId    = String(chunk.id ?? chunk.type ?? chunksEmbedded);
      const chunkTitle = String(chunk.title ?? '');
      const content    = String(chunk.content ?? '');
      const chunkType  = String(chunk.type ?? 'default');

      try {
        const embedding = tfidf(`${chunkTitle} ${content}`, vocab, df, validChunks.length);

        const { error: upsertErr } = await admin.from('isi_chunk_embeddings').upsert({
          site_id,
          chunk_id:      chunkId,
          chunk_type:    chunkType,
          chunk_title:   chunkTitle,
          chunk_content: content.slice(0, 1000),
          embedding,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'site_id,chunk_id' });
        if (upsertErr) throw new Error(upsertErr.message);

        chunksEmbedded++;

        const questions = TEMPLATES[chunkType] ?? TEMPLATES.default;
        for (const q of questions) {
          const { error: insErr } = await admin.from('isi_benchmark_tests').insert({
            site_id, query: q, expected_chunk_id: chunkId,
          });
          if (insErr) throw new Error(insErr.message);
          testsGenerated++;
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
