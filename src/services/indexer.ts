// src/services/indexer.ts
// What: Orchestrates scan → convert → chunk → embed → store pipeline for new PDFs.
 // How: Scans the library dir, relies on INSERT ... ON CONFLICT (filename) DO NOTHING for idempotency/race-safety,
 //      then converts to Markdown via Python markitdown with guardrails, chunks Markdown, embeds chunks with OpenAI,
 //      and inserts chunks/embeddings in small batched DB transactions using ::vector casting.
 //      Concurrency controlled via p-limit. Avoids pool leaks by not returning before client.release() in finally.

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
  const limit = pLimit(Number(config.INDEX_CONCURRENCY) || 1);

  const newly_indexed: NewIndexed[] = [];
  const skipped_existing: string[] = [];
  const failed: { filename: string; error: string }[] = [];

  await Promise.all(
    files.map((f) =>
      limit(async () => {
        // Generate ID up-front; rely on unique(filename) for idempotency
        const bookId = uuidv4();
        let bookInserted = false;

        try {
          // 1) Insert book row early to reserve work; skip if already indexed (by filename)
          // Use pool.query for one-off statement to avoid holding a client
          const insertRes = await pool.query(
            'INSERT INTO books (id, filename, path) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING',
            [bookId, f.filename, f.path],
          );
          if (insertRes.rowCount === 0) {
            // Already exists due to filename unique constraint -> skip
            skipped_existing.push(f.filename);
            return;
          }
          bookInserted = true;

          // Mark as scanned immediately so we retain the book even if downstream steps fail.
          try {
            await pool.query('UPDATE books SET status = $1, error_text = NULL WHERE id = $2', [
              'scanned',
              bookId,
            ]);
          } catch {
            // ignore status update errors
          }

          // 2) Convert to Markdown (no DB connection held during CPU/IO heavy work)
          // Pass resource guardrails from config to reduce memory pressure on old hardware
          let md: string;
          try {
            md = await convertPdfToMarkdown(f.path, {
              timeoutMs: config.MARKITDOWN_TIMEOUT_MS,
              maxBytes: config.MARKITDOWN_MAX_BYTES,
            });
          } catch (convErr: any) {
            if (bookInserted) {
              try {
                await pool.query('UPDATE books SET status = $1, error_text = $2 WHERE id = $3', [
                  'failed_parse',
                  convErr?.message ?? 'PDF->Markdown conversion failed',
                  bookId,
                ]);
              } catch {
                // ignore update errors
              }
            }
            throw convErr;
          }

          // 3) Chunk markdown
          const chunks = chunkMarkdown(md);
          if (chunks.length === 0) {
            logger.warn({ file: f.path }, 'No chunks produced; marking book as failed_parse');
            try {
              await pool.query('UPDATE books SET status = $1, error_text = $2 WHERE id = $3', [
                'failed_parse',
                'No chunks produced',
                bookId,
              ]);
            } catch {
              // ignore update errors
            }
            return;
          }

          // 4) Embed and insert in small batches to cap memory and DB pressure
          const batchSize = Number(config.EMBED_BATCH_SIZE) || 32;
          for (let offset = 0; offset < chunks.length; offset += batchSize) {
            const chunkBatch = chunks.slice(offset, offset + batchSize);

            // 4a) Compute embeddings for the batch (no DB connection held)
            let vectorsBatch: number[][];
            try {
              vectorsBatch = await embedMany(chunkBatch);
            } catch (embErr: any) {
              try {
                await pool.query('UPDATE books SET status = $1, error_text = $2 WHERE id = $3', [
                  'failed_embed',
                  embErr?.message ?? 'Embedding failed',
                  bookId,
                ]);
              } catch {
                // ignore update errors
              }
              throw embErr;
            }

            // 5) Insert this batch in a short transaction to limit WAL/memory
            const client = await pool.connect();
            let inTx = false;
            try {
              await client.query('BEGIN');
              inTx = true;

              for (let i = 0; i < chunkBatch.length; i++) {
                const chunkId = uuidv4();
                const embedding = vectorToParam(vectorsBatch[i]);
                await client.query(
                  'INSERT INTO chunks (id, book_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
                  [chunkId, bookId, offset + i, chunkBatch[i], embedding],
                );
              }

              await client.query('COMMIT');
              inTx = false;
            } catch (txErr: any) {
              if (inTx) {
                try {
                  await client.query('ROLLBACK');
                } catch {
                  // ignore rollback errors
                }
              }
              try {
                await pool.query('UPDATE books SET status = $1, error_text = $2 WHERE id = $3', [
                  'failed_insert',
                  txErr?.message ?? 'Batch insert failed',
                  bookId,
                ]);
              } catch {
                // ignore update errors
              }
              throw txErr;
            } finally {
              client.release();
            }
          }

          // All batches inserted successfully -> mark as indexed
          try {
            await pool.query(
              'UPDATE books SET status = $1, error_text = NULL, path = $2, /* keep path fresh */ created_at = created_at, last_indexed_at = NOW() WHERE id = $3',
              ['indexed', f.path, bookId],
            );
            // Also store chunk count if column exists (migration 002)
            try {
              await pool.query('UPDATE books SET chunks_count = $1 WHERE id = $2', [chunks.length, bookId]);
            } catch {
              // ignore if column not present
            }
          } catch {
            // ignore status update errors
          }

          newly_indexed.push({ id: bookId, filename: f.filename, path: f.path, chunks: chunks.length });
        } catch (err: any) {
          // Attempt to record error on the book if downstream steps failed; do not delete the book
          if (bookInserted) {
            try {
              await pool.query('UPDATE books SET error_text = $2 WHERE id = $1', [
                bookId,
                err?.message ?? 'Unknown error',
              ]);
            } catch {
              // ignore cleanup errors
            }
          }
          logger.error({ err, file: f.path }, 'Indexing failed');
          failed.push({ filename: f.filename, error: err?.message ?? 'Unknown error' });
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