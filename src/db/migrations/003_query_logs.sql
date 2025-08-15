-- src/db/migrations/003_query_logs.sql
-- What: Create query_logs table to record search/chat requests with timestamp and optional embedding.
-- How: Defines query_logs with UUID PK provided by app code, kind enum-like check, optional vector(1536),
--      and convenience columns (top_k, temperature). Adds index on created_at for recent queries lookups.

BEGIN;

-- Ensure pgvector is available (idempotent; safe if already created in 001)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS query_logs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'chat')),
  query_text TEXT NOT NULL,
  embedding VECTOR(1536), -- optional: store the already-generated query embedding
  top_k INT,
  temperature REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_logs_created_at ON query_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_logs_kind_created_at ON query_logs (kind, created_at DESC);

COMMIT;