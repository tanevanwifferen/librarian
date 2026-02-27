// src/routes/search.ts
// What: /search route for semantic vector search over chunks.
// How: Validates input with zod, embeds the query. Uses an optimized query that:
//      1. First fetches top chunks using the ivfflat index (fast)
//      2. Then deduplicates by book using ROW_NUMBER window function
//      3. Returns only the best chunk per book, limited to topK books
//      Opens a short transaction for SET LOCAL ivfflat.probes and SELECT, then commits.
//      Maps results AFTER the transaction to avoid "no transaction in progress" warnings.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { embedText } from '../services/embeddings.js';
import { clampSimilarity, vectorToParam } from '../util/sql.js';
import { v4 as uuidv4 } from 'uuid';
import { searchArxiv } from '../services/arxiv.js';

const schema = z.object({
  // Cap query length to avoid oversized embedding requests and responses
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(100).optional().default(8),
  arxivTopK: z.number().int().positive().max(50).optional().default(5),
});

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { query: q, topK, arxivTopK } = parsed.data;

    const qv = await embedText(q);
    const qvParam = vectorToParam(qv);

    // Log the search query with optional embedding and parameters.
    // We insert outside the retrieval transaction to keep the critical path short.
    try {
      const logId = uuidv4();
      await pool.query(
        'INSERT INTO query_logs (id, kind, query_text, embedding, top_k, temperature) VALUES ($1,$2,$3,$4::vector,$5,$6)',
        [logId, 'search', q, qvParam, topK, null],
      );
    } catch {
      // Swallow logging errors to avoid impacting the endpoint
    }

    const client = await pool.connect();
    let rows: any[] = [];
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      // Better recall for ivfflat queries
      await client.query('SET LOCAL ivfflat.probes = 10');

      // Optimized query: First get top chunks using the index, then deduplicate by book.
      // This is much faster as it leverages the ivfflat index to limit distance calculations.
      const sql = `
        WITH top_chunks AS (
          -- Get more chunks than needed to ensure we have enough unique books
          SELECT c.id, c.book_id, c.chunk_index,
                 c.embedding <=> $1::vector AS distance
          FROM chunks c
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2 * 3  -- Get 3x topK to ensure enough unique books after deduplication
        ),
        ranked_chunks AS (
          -- Rank chunks within each book
          SELECT tc.*,
                 b.id AS b_id, b.filename, b.path,
                 ROW_NUMBER() OVER (PARTITION BY tc.book_id ORDER BY tc.distance) AS rn
          FROM top_chunks tc
          JOIN books b ON b.id = tc.book_id
        )
        -- Select only the best chunk per book, limit to topK books
        SELECT id, book_id, chunk_index, distance, b_id, filename, path
        FROM ranked_chunks
        WHERE rn = 1
        ORDER BY distance
        LIMIT $2;
      `;
      const r = await client.query(sql, [qvParam, topK]);
      rows = r.rows;
      await client.query('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw err;
    } finally {
      client.release();
    }

    // Do not include raw chunk content in the /search response to keep payloads small.
    const matches = rows.map((row: any) => ({
      book: { id: row.b_id as string, filename: row.filename as string, path: row.path as string },
      chunk_index: Number(row.chunk_index),
      distance: Number(row.distance),
      score: clampSimilarity(Number(row.distance)),
    }));

    // Fetch arXiv results in parallel (graceful degradation on failure)
    let arxiv_matches: any[] = [];
    try {
      arxiv_matches = await searchArxiv(q, arxivTopK);
    } catch {
      // arXiv service unavailable — return empty results without breaking local search
    }

    res.json({ query: q, topK, matches, arxiv_matches });
  } catch (err) {
    next(err);
  }
});

export default router;