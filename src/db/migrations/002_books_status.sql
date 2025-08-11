-- src/db/migrations/002_books_status.sql
-- What: Add status/error_text/last_indexed_at/chunks_count columns to books to support fault-tolerant ingestion.
-- How: ALTER TABLE ... IF NOT EXISTS to add columns safely, then backfill status to 'indexed' for books that already have chunks.

BEGIN;

ALTER TABLE books
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS error_text TEXT,
  ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chunks_count INT;

-- Backfill: mark books with existing chunks as indexed when no status is set yet.
UPDATE books b
SET status = 'indexed'
WHERE b.status IS NULL
  AND EXISTS (SELECT 1 FROM chunks c WHERE c.book_id = b.id);

COMMIT;