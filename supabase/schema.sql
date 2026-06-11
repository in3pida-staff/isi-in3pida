-- isi-in3pida Database Schema
-- Esegui questo file nel SQL Editor di Supabase

CREATE TABLE IF NOT EXISTS isi_sites (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id text UNIQUE NOT NULL,
    site_url text NOT NULL,
    site_name text,
    plugin_version text,
    wp_version text,
    php_version text,
    pse_enabled boolean DEFAULT false,
    tier text DEFAULT 'free',
    geo_scores jsonb DEFAULT '{}',
    hotel_profile jsonb DEFAULT '{}',
    schema_data jsonb DEFAULT '{}',
    faq_data jsonb DEFAULT '{}',
    last_heartbeat timestamptz,
    first_seen timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
);
-- Per database esistenti:
-- ALTER TABLE isi_sites ADD COLUMN IF NOT EXISTS hotel_profile jsonb DEFAULT '{}';
-- ALTER TABLE isi_sites ADD COLUMN IF NOT EXISTS schema_data jsonb DEFAULT '{}';
-- ALTER TABLE isi_sites ADD COLUMN IF NOT EXISTS faq_data jsonb DEFAULT '{}';

CREATE TABLE IF NOT EXISTS isi_pse_queries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id text NOT NULL,
    site_name text,
    query text NOT NULL,
    tokens_in integer DEFAULT 0,
    tokens_out integer DEFAULT 0,
    cost_usd numeric(10,6) DEFAULT 0,
    model text DEFAULT 'claude-haiku-4-5-20251001',
    result jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS isi_plugin_versions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    version text UNIQUE NOT NULL,
    changelog text,
    download_url text,
    is_current boolean DEFAULT false,
    released_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_isi_sites_site_id ON isi_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_isi_pse_site ON isi_pse_queries(site_id);
CREATE INDEX IF NOT EXISTS idx_isi_pse_time ON isi_pse_queries(created_at DESC);

-- Retrieval Benchmark tables
CREATE TABLE IF NOT EXISTS isi_chunk_embeddings (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id text NOT NULL,
    chunk_id text NOT NULL,
    chunk_type text,
    chunk_title text,
    chunk_content text,
    embedding jsonb NOT NULL,
    updated_at timestamptz DEFAULT now(),
    UNIQUE(site_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS isi_benchmark_tests (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id text NOT NULL,
    query text NOT NULL,
    expected_chunk_id text NOT NULL,
    generated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS isi_benchmark_runs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    site_id text NOT NULL,
    site_name text,
    run_at timestamptz DEFAULT now(),
    precision_1 float,
    precision_3 float,
    mrr float,
    total_queries int,
    passed_1 int,
    results jsonb
);

CREATE INDEX IF NOT EXISTS idx_chunk_emb_site ON isi_chunk_embeddings(site_id);
CREATE INDEX IF NOT EXISTS idx_bench_tests_site ON isi_benchmark_tests(site_id);
CREATE INDEX IF NOT EXISTS idx_bench_runs_site ON isi_benchmark_runs(site_id, run_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE isi_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE isi_pse_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE isi_plugin_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE isi_chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE isi_benchmark_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE isi_benchmark_runs ENABLE ROW LEVEL SECURITY;

-- isi_plugin_versions: lettura pubblica (il plugin WP verifica aggiornamenti senza auth)
CREATE POLICY "plugin_versions_public_read" ON isi_plugin_versions
  FOR SELECT USING (true);

-- isi_plugin_versions: gestione completa per utenti autenticati (admin dashboard ISI)
CREATE POLICY "plugin_versions_authenticated_all" ON isi_plugin_versions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- isi_sites: accesso completo per utenti autenticati (dashboard ISI)
CREATE POLICY "sites_authenticated_all" ON isi_sites
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- isi_sites: il plugin WP (anon key) può inserire e aggiornare heartbeat/dati
CREATE POLICY "sites_anon_insert" ON isi_sites
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "sites_anon_update" ON isi_sites
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- isi_pse_queries: accesso completo per utenti autenticati
CREATE POLICY "pse_authenticated_all" ON isi_pse_queries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- isi_pse_queries: il plugin WP (anon) può inserire query PSE
CREATE POLICY "pse_anon_insert" ON isi_pse_queries
  FOR INSERT TO anon WITH CHECK (true);

-- isi_chunk_embeddings: solo utenti autenticati
CREATE POLICY "chunks_authenticated_all" ON isi_chunk_embeddings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- isi_benchmark_tests: solo utenti autenticati
CREATE POLICY "bench_tests_authenticated_all" ON isi_benchmark_tests
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- isi_benchmark_runs: solo utenti autenticati
CREATE POLICY "bench_runs_authenticated_all" ON isi_benchmark_runs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
