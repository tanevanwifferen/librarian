-- What: Add file_hash column to books table for duplicate detection.
-- How: Add nullable TEXT column, unique constraint, and index for fast lookups.

BEGIN;

-- Add file_hash column (nullable to support existing rows)
ALTER TABLE books ADD COLUMN IF NOT EXISTS file_hash TEXT;

-- Create unique constraint on file_hash (NULL values don't conflict)
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_hash_unique ON books(file_hash) WHERE file_hash IS NOT NULL;

-- Create index for fast hash lookups
CREATE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash) WHERE file_hash IS NOT NULL;

COMMIT;
