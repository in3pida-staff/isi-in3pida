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
    last_heartbeat timestamptz,
    first_seen timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
);

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

ALTER TABLE isi_sites DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_pse_queries DISABLE ROW LEVEL SECURITY;
ALTER TABLE isi_plugin_versions DISABLE ROW LEVEL SECURITY;
