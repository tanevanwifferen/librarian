// src/services/indexer.ts
// What: Orchestrates scan → convert → chunk → embed → store pipeline for new PDFs.
// How: Scans the library dir, relies on INSERT ... ON CONFLICT (filename) DO NOTHING for idempotency/race-safety,
//      then converts to Markdown via Python markitdown with guardrails, chunks Markdown, embeds chunks with OpenAI,
//      and inserts chunks/embeddings in small batched DB transactions using ::vector casting.
//      Concurrency controlled via p-limit. Avoids pool leaks by not returning before client.release() in finally.

import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import pLimit from "p-limit";
import { pool } from "../db/pool.js";
import config from "../config/env.js";
import logger from "../logging.js";
import { scanLibrary } from "./scanner.js";
import { convertPdfToMarkdown } from "./markitdown.js";
import { chunkMarkdown } from "./chunking.js";
import { embedMany } from "./embeddings.js";
import { vectorToParam } from "../util/sql.js";

// Business-hours gating (Europe/Amsterdam: 08:00–21:00)
const BUSINESS_TZ = "Europe/Amsterdam";

function getLocalHourMinuteAmsterdam(d: Date = new Date()): {
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}

// Inclusive start 08:00, exclusive end 21:00 local Amsterdam time
function isWithinBusinessHoursEuropeAmsterdam(d: Date = new Date()): boolean {
  const { hour } = getLocalHourMinuteAmsterdam(d);
  return hour >= 8 && hour < 21;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polling wait to avoid complex timezone math without extra deps.
// Checks every 60s and resumes once within the window.
async function waitForBusinessHoursIfNeeded(stage: string): Promise<void> {
  if (isWithinBusinessHoursEuropeAmsterdam()) return;
  logger.info(
    { stage, tz: BUSINESS_TZ },
    "Outside business hours; pausing indexing until window opens"
  );
  // Log first wait immediately, then re-check every minute
  while (!isWithinBusinessHoursEuropeAmsterdam()) {
    await sleep(60_000);
  }
  logger.info(
    { stage, tz: BUSINESS_TZ },
    "Business hours window open; resuming indexing"
  );
}

interface NewIndexed {
  id: string;
  filename: string;
  path: string;
  chunks: number;
}

// Result type for single file indexing
export interface SingleFileResult {
  success: boolean;
  book_id: string;
  filename: string;
  chunks_count: number;
  status: 'indexed' | 'already_exists' | 'failed_parse' | 'failed_embed' | 'failed_insert';
  error?: string;
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
  // Gate entire scan to business hours window
  await waitForBusinessHoursIfNeeded("run-start");
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
            "INSERT INTO books (id, filename, path) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING",
            [bookId, f.filename, f.path]
          );
          if (insertRes.rowCount === 0) {
            // Already exists due to filename unique constraint -> skip
            skipped_existing.push(f.filename);
            return;
          }
          bookInserted = true;

          // Mark as scanned immediately so we retain the book even if downstream steps fail.
          try {
            await pool.query(
              "UPDATE books SET status = $1, error_text = NULL WHERE id = $2",
              ["scanned", bookId]
            );
          } catch {
            // ignore status update errors
          }

          // 2) Convert to Markdown (no DB connection held during CPU/IO heavy work)
          // Pass resource guardrails from config to reduce memory pressure on old hardware
          let md: string;
          // Cooperatively pause before starting heavy conversion work
          await waitForBusinessHoursIfNeeded("before-convert");
          try {
            md = await convertPdfToMarkdown(f.path, {
              timeoutMs: config.MARKITDOWN_TIMEOUT_MS,
              maxBytes: config.MARKITDOWN_MAX_BYTES,
            });
          } catch (convErr: any) {
            if (bookInserted) {
              try {
                await pool.query(
                  "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
                  [
                    "failed_parse",
                    convErr?.message ?? "PDF->Markdown conversion failed",
                    bookId,
                  ]
                );
              } catch {
                // ignore update errors
              }
            }
            throw convErr;
          }

          // 3) Chunk markdown
          const chunks = chunkMarkdown(md);
          if (chunks.length === 0) {
            logger.warn(
              { file: f.path },
              "No chunks produced; marking book as failed_parse"
            );
            try {
              await pool.query(
                "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
                ["failed_parse", "No chunks produced", bookId]
              );
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
            // Cooperatively pause between batches to respect business hours
            await waitForBusinessHoursIfNeeded("before-embed-batch");
            let vectorsBatch: number[][];
            try {
              vectorsBatch = await embedMany(chunkBatch);
            } catch (embErr: any) {
              try {
                await pool.query(
                  "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
                  [
                    "failed_embed",
                    embErr?.message ?? "Embedding failed",
                    bookId,
                  ]
                );
              } catch {
                // ignore update errors
              }
              throw embErr;
            }

            // 5) Insert this batch in a short transaction to limit WAL/memory
            const client = await pool.connect();
            let inTx = false;
            try {
              await client.query("BEGIN");
              inTx = true;

              for (let i = 0; i < chunkBatch.length; i++) {
                const chunkId = uuidv4();
                const embedding = vectorToParam(vectorsBatch[i]);
                await client.query(
                  "INSERT INTO chunks (id, book_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)",
                  [chunkId, bookId, offset + i, chunkBatch[i], embedding]
                );
              }

              await client.query("COMMIT");
              inTx = false;
            } catch (txErr: any) {
              if (inTx) {
                try {
                  await client.query("ROLLBACK");
                } catch {
                  // ignore rollback errors
                }
              }
              try {
                await pool.query(
                  "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
                  [
                    "failed_insert",
                    txErr?.message ?? "Batch insert failed",
                    bookId,
                  ]
                );
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
              "UPDATE books SET status = $1, error_text = NULL, path = $2, /* keep path fresh */ created_at = created_at, last_indexed_at = NOW() WHERE id = $3",
              ["indexed", f.path, bookId]
            );
            // Also store chunk count if column exists (migration 002)
            try {
              await pool.query(
                "UPDATE books SET chunks_count = $1 WHERE id = $2",
                [chunks.length, bookId]
              );
            } catch {
              // ignore if column not present
            }
          } catch {
            // ignore status update errors
          }

          newly_indexed.push({
            id: bookId,
            filename: f.filename,
            path: f.path,
            chunks: chunks.length,
          });
        } catch (err: any) {
          // Attempt to record error on the book if downstream steps failed; do not delete the book
          if (bookInserted) {
            try {
              await pool.query(
                "UPDATE books SET error_text = $2 WHERE id = $1",
                [bookId, err?.message ?? "Unknown error"]
              );
            } catch {
              // ignore cleanup errors
            }
          }
          logger.error({ err, file: f.path }, "Indexing failed");
          failed.push({
            filename: f.filename,
            error: err?.message ?? "Unknown error",
          });
        }
      })
    )
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
  const ts = new Date().toISOString().replace(/[:.]/g, "");
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

/**
 * Index a single file. Used for uploads where we already have the file saved.
 * @param filePath Absolute path to the file
 * @param filename The filename to store in the database
 * @param fileHash Optional SHA256 hash for duplicate detection
 */
export async function indexSingleFile(
  filePath: string,
  filename: string,
  fileHash?: string
): Promise<SingleFileResult> {
  const bookId = uuidv4();

  // 1) Check for duplicate by hash if provided
  if (fileHash) {
    const existing = await pool.query(
      "SELECT id, filename FROM books WHERE file_hash = $1",
      [fileHash]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // Get chunks count for the existing book
      const chunksRes = await pool.query(
        "SELECT COUNT(*)::int as count FROM chunks WHERE book_id = $1",
        [row.id]
      );
      return {
        success: true,
        book_id: row.id,
        filename: row.filename,
        chunks_count: chunksRes.rows[0]?.count || 0,
        status: 'already_exists',
      };
    }
  }

  try {
    // 2) Insert book row with hash
    const insertRes = await pool.query(
      "INSERT INTO books (id, filename, path, file_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (filename) DO NOTHING",
      [bookId, filename, filePath, fileHash || null]
    );
    if (insertRes.rowCount === 0) {
      // Already exists by filename -> check if same hash or different
      const existingByName = await pool.query(
        "SELECT id, file_hash FROM books WHERE filename = $1",
        [filename]
      );
      if (existingByName.rows.length > 0) {
        const row = existingByName.rows[0];
        const chunksRes = await pool.query(
          "SELECT COUNT(*)::int as count FROM chunks WHERE book_id = $1",
          [row.id]
        );
        return {
          success: true,
          book_id: row.id,
          filename,
          chunks_count: chunksRes.rows[0]?.count || 0,
          status: 'already_exists',
        };
      }
    }

    // Mark as scanned
    await pool.query(
      "UPDATE books SET status = $1, error_text = NULL WHERE id = $2",
      ["scanned", bookId]
    );

    // 3) Convert to Markdown
    let md: string;
    try {
      md = await convertPdfToMarkdown(filePath, {
        timeoutMs: config.MARKITDOWN_TIMEOUT_MS,
        maxBytes: config.MARKITDOWN_MAX_BYTES,
      });
    } catch (convErr: any) {
      await pool.query(
        "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
        ["failed_parse", convErr?.message ?? "PDF->Markdown conversion failed", bookId]
      );
      return {
        success: false,
        book_id: bookId,
        filename,
        chunks_count: 0,
        status: 'failed_parse',
        error: convErr?.message ?? "PDF->Markdown conversion failed",
      };
    }

    // 4) Chunk markdown
    const chunks = chunkMarkdown(md);
    if (chunks.length === 0) {
      await pool.query(
        "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
        ["failed_parse", "No chunks produced", bookId]
      );
      return {
        success: false,
        book_id: bookId,
        filename,
        chunks_count: 0,
        status: 'failed_parse',
        error: "No chunks produced from PDF",
      };
    }

    // 5) Embed and insert in small batches
    const batchSize = Number(config.EMBED_BATCH_SIZE) || 32;
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const chunkBatch = chunks.slice(offset, offset + batchSize);

      let vectorsBatch: number[][];
      try {
        vectorsBatch = await embedMany(chunkBatch);
      } catch (embErr: any) {
        await pool.query(
          "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
          ["failed_embed", embErr?.message ?? "Embedding failed", bookId]
        );
        return {
          success: false,
          book_id: bookId,
          filename,
          chunks_count: 0,
          status: 'failed_embed',
          error: embErr?.message ?? "Embedding failed",
        };
      }

      // Insert batch in transaction
      const client = await pool.connect();
      let inTx = false;
      try {
        await client.query("BEGIN");
        inTx = true;

        for (let i = 0; i < chunkBatch.length; i++) {
          const chunkId = uuidv4();
          const embedding = vectorToParam(vectorsBatch[i]);
          await client.query(
            "INSERT INTO chunks (id, book_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)",
            [chunkId, bookId, offset + i, chunkBatch[i], embedding]
          );
        }

        await client.query("COMMIT");
        inTx = false;
      } catch (txErr: any) {
        if (inTx) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // ignore rollback errors
          }
        }
        await pool.query(
          "UPDATE books SET status = $1, error_text = $2 WHERE id = $3",
          ["failed_insert", txErr?.message ?? "Batch insert failed", bookId]
        );
        return {
          success: false,
          book_id: bookId,
          filename,
          chunks_count: 0,
          status: 'failed_insert',
          error: txErr?.message ?? "Batch insert failed",
        };
      } finally {
        client.release();
      }
    }

    // 6) Mark as indexed
    await pool.query(
      "UPDATE books SET status = $1, error_text = NULL, last_indexed_at = NOW(), chunks_count = $2 WHERE id = $3",
      ["indexed", chunks.length, bookId]
    );

    return {
      success: true,
      book_id: bookId,
      filename,
      chunks_count: chunks.length,
      status: 'indexed',
    };
  } catch (err: any) {
    logger.error({ err, file: filePath }, "Single file indexing failed");
    // Try to update error on the book
    try {
      await pool.query(
        "UPDATE books SET error_text = $2 WHERE id = $1",
        [bookId, err?.message ?? "Unknown error"]
      );
    } catch {
      // ignore cleanup errors
    }
    return {
      success: false,
      book_id: bookId,
      filename,
      chunks_count: 0,
      status: 'failed_parse',
      error: err?.message ?? "Unknown error",
    };
  }
}
