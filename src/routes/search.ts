// src/routes/search.ts
// What: /search route for semantic vector search over chunks.
// How: Validates input with zod, embeds the query. Opens a short transaction just for
//      SET LOCAL ivfflat.probes and the SELECT, then commits. Maps results and responds
//      AFTER the transaction to avoid rolling back when no transaction is active, which
//      prevents "there is no transaction in progress" warnings.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { embedText } from '../services/embeddings.js';
import { clampSimilarity, vectorToParam } from '../util/sql.js';
import { v4 as uuidv4 } from 'uuid';

const schema = z.object({
  // Cap query length to avoid oversized embedding requests and responses
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(100).optional().default(8),
});

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { query: q, topK } = parsed.data;

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

      // Ensure only one best match per book, then order books by the best distance.
      // We first pick the closest chunk per book in a CTE, then sort that result by distance.
      const sql = `
        WITH
        q AS (SELECT $1::vector AS qv),
        best_per_book AS (
          SELECT DISTINCT ON (b.id)
                 c.id, c.book_id, c.chunk_index, (c.embedding <=> q.qv) AS distance,
                 b.id AS b_id, b.filename, b.path
          FROM chunks c
          JOIN books b ON b.id = c.book_id, q
          ORDER BY b.id, (c.embedding <=> q.qv)
        )
        SELECT * FROM best_per_book
        ORDER BY distance
        LIMIT $2
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

    res.json({ query: q, topK, matches });
  } catch (err) {
    next(err);
  }
});

export default router;