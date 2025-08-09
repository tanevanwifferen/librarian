// src/routes/search.ts
// What: /search route for semantic vector search over chunks.
// How: Validates input with zod, embeds the query, sets ivfflat.probes within a transaction,
//      performs cosine distance search via pgvector ivfflat, and returns scored matches.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { embedText } from '../services/embeddings.js';
import { clampSimilarity, vectorToParam } from '../util/sql.js';

const schema = z.object({
  query: z.string().min(1),
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Better recall for ivfflat queries
      await client.query('SET LOCAL ivfflat.probes = 10');

      const sql = `
        WITH q AS (SELECT $1::vector AS qv)
        SELECT c.id, c.book_id, c.chunk_index, c.content, (c.embedding <=> q.qv) AS distance,
               b.id AS b_id, b.filename, b.path
        FROM chunks c
        JOIN books b ON b.id = c.book_id, q
        ORDER BY c.embedding <=> q.qv
        LIMIT $2
      `;
      const r = await client.query(sql, [qvParam, topK]);
      await client.query('COMMIT');

      const matches = r.rows.map((row: any) => ({
        book: { id: row.b_id as string, filename: row.filename as string, path: row.path as string },
        chunk_index: Number(row.chunk_index),
        content: String(row.content),
        distance: Number(row.distance),
        score: clampSimilarity(Number(row.distance)),
      }));

      res.json({ query: q, topK, matches });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export default router;