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

ALTER TABLE isi_sites DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_pse_queries DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_plugin_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_chunk_embeddings DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_benchmark_tests DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_benchmark_runs DISABLE ROW LEVEL SECURITY;
