-- What: Initialize vector extension, tables, and indexes for books and chunks.
-- How: Create vector extension, define books and chunks tables without DB-side UUID defaults,
-- apply unique and ivfflat indexes, and add FK with cascade.

BEGIN;

-- Ensure pgvector is available
CREATE EXTENSION IF NOT EXISTS vector;

-- books table
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_filename_unique ON books(filename);

-- For cosine distance, use vector_cosine_ops and ivfflat with a reasonable number of lists
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_ivfflat
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_chunks_book_id ON chunks(book_id);

COMMIT;