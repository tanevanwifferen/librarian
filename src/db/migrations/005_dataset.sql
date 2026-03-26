-- Migration 005: Add dataset column to books table
-- All existing books default to 'occult'; new custom uploads will use 'custom'.

ALTER TABLE books ADD COLUMN IF NOT EXISTS dataset TEXT NOT NULL DEFAULT 'occult';

CREATE INDEX IF NOT EXISTS idx_books_dataset ON books (dataset);
