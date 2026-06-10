-- Aggiungi colonna per rate limiting reason gap
ALTER TABLE isi_sites ADD COLUMN IF NOT EXISTS last_reason_gap_at timestamptz;

-- Tabella risultati reason gap
CREATE TABLE IF NOT EXISTS isi_reason_gap_results (
  id           bigserial primary key,
  site_id      text not null,
  site_name    text,
  query        text not null,
  cat          text,
  gaps         jsonb,
  model        text default 'gemini-2.0-flash',
  cost_usd     numeric(10,6) default 0,
  created_at   timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_reason_gap_site_id ON isi_reason_gap_results(site_id);
CREATE INDEX IF NOT EXISTS idx_reason_gap_created ON isi_reason_gap_results(created_at);
