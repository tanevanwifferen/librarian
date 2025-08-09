// src/services/indexer.ts
// What: Orchestrates scan → convert → chunk → embed → store pipeline for new PDFs.
// How: Scans the library dir, pre-checks existence by full path/filename to avoid reprocessing,
//      then inserts a book (INSERT ... ON CONFLICT (filename) DO NOTHING to guard races), converts to Markdown
//      via Python markitdown with guardrails, chunks Markdown, embeds chunks with OpenAI, and inserts
//      chunks/embeddings in a single DB transaction using ::vector casting. Concurrency controlled via p-limit.

import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';
import { pool } from '../db/pool.js';
import config from '../config/env.js';
import logger from '../logging.js';
import { scanLibrary } from './scanner.js';
import { convertPdfToMarkdown } from './markitdown.js';
import { chunkMarkdown } from './chunking.js';
import { embedMany } from './embeddings.js';
import { vectorToParam } from '../util/sql.js';

interface NewIndexed {
  id: string;
  filename: string;
  path: string;
  chunks: number;
}

export interface ScanResult {
  correlation_id: string;
  scanned_count: number;
  newly_indexed_count: number;
  newly_indexed: NewIndexed[];
  skipped_existing: string[];
  failed: { filename: string; error: string }[];
  duration_ms: number;
}

export async function runScan(correlationId: string): Promise<ScanResult> {
  const start = Date.now();
  const files = await scanLibrary();
  const limit = pLimit(Number(config.INDEX_CONCURRENCY) || 2);

  const newly_indexed: NewIndexed[] = [];
  const skipped_existing: string[] = [];
  const failed: { filename: string; error: string }[] = [];

  await Promise.all(
    files.map((f) =>
      limit(async () => {
        const client = await pool.connect();
        // Pre-check by path/filename to avoid reprocessing on reruns
        const existing = await client.query(
          'SELECT id FROM books WHERE path = $1 OR filename = $2 LIMIT 1',
          [f.path, f.filename],
        );
        if (existing.rowCount > 0) {
          skipped_existing.push(f.filename);
          return;
        }
        const bookId = uuidv4();

        try {
          // 1) Insert book row early to reserve work; skip if already indexed (by filename)
          const insertRes = await client.query(
            'INSERT INTO books (id, filename, path) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING',
            [bookId, f.filename, f.path],
          );
          if (insertRes.rowCount === 0) {
            // Already exists due to filename unique constraint -> skip
            skipped_existing.push(f.filename);
            return;
          }

          // 2) Convert to Markdown
          const md = await convertPdfToMarkdown(f.path);

          // 3) Chunk markdown
          const chunks = chunkMarkdown(md);
          if (chunks.length === 0) {
            logger.warn({ file: f.path }, 'No chunks produced; deleting book row');
            await client.query('DELETE FROM books WHERE id = $1', [bookId]);
            return;
          }

          // 4) Embed each chunk
          const vectors = await embedMany(chunks);

          // 5) Insert chunks in a DB transaction
          await client.query('BEGIN');
          for (let i = 0; i < chunks.length; i++) {
            const chunkId = uuidv4();
            const embedding = vectorToParam(vectors[i]);
            await client.query(
              'INSERT INTO chunks (id, book_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
              [chunkId, bookId, i, chunks[i], embedding],
            );
          }
          await client.query('COMMIT');

          newly_indexed.push({ id: bookId, filename: f.filename, path: f.path, chunks: chunks.length });
        } catch (err: any) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore rollback errors
          }
          // Attempt cleanup if the book was inserted but chunks failed
          try {
            await client.query('DELETE FROM books WHERE id = $1', [bookId]);
          } catch {
            // ignore cleanup errors
          }
          logger.error({ err, file: f.path }, 'Indexing failed');
          failed.push({ filename: f.filename, error: err?.message ?? 'Unknown error' });
        } finally {
          client.release();
        }
      }),
    ),
  );

  const duration_ms = Date.now() - start;
  return {
    correlation_id: correlationId,
    scanned_count: files.length,
    newly_indexed_count: newly_indexed.length,
    newly_indexed,
    skipped_existing,
    failed,
    duration_ms,
  };
}

// Helper to create correlation IDs for scanning tasks
export function newCorrelationId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const rand = randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}