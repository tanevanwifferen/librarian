// src/routes/books.ts
// What: /books route to list indexed books with chunk counts.
// How: Runs a LEFT JOIN aggregation query and returns { items, total } as JSON.

import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sql = `
      SELECT b.id, b.filename, b.path, b.created_at, COALESCE(c.cnt,0) AS chunk_count
      FROM books b
      LEFT JOIN (SELECT book_id, COUNT(*) cnt FROM chunks GROUP BY book_id) c ON c.book_id = b.id
      ORDER BY b.created_at DESC
    `;
    const result = await query(sql);
    res.json({ items: result.rows, total: result.rowCount });
  } catch (err) {
    next(err);
  }
});

export default router;