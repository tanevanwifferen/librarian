/**
 * src/routes/books.ts
 * What: /books route to list indexed books with chunk counts and download a specific book by id.
 * How:
 *  - GET /books: LEFT JOIN aggregation to include chunk counts.
 *  - GET /books/:id/download: Fetch path + filename for the book and stream the file using res.download.
 *    Returns 404 if not found or file missing. Content-Disposition is set for Discord filename detection.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';
import { promises as fs } from 'fs';

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

router.get('/:id/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const sql = `SELECT id, filename, path FROM books WHERE id = $1 LIMIT 1`;
    const r = await query(sql, [id]);
    if ((r.rowCount ?? 0) === 0) {
      res.status(404).json({ error: { message: 'book_not_found' } });
      return;
    }
    const row = r.rows[0] as { id: string; filename: string; path: string };
    const filePath = row.path;
    const fileName = row.filename || `${row.id}.bin`;

    // Ensure file exists
    await fs.access(filePath);

    // Let Express set headers + stream the file
    res.download(filePath, fileName, (err?: Error) => {
      if (err) next(err);
    });
  } catch (err: any) {
    if ((err as any).code === 'ENOENT') {
      res.status(404).json({ error: { message: 'file_missing' } });
      return;
    }
    next(err);
  }
});

// What: Download a book by its filename.
// How: Looks up the book row by filename and streams the file. Filename path param must be URL-encoded.
router.get('/by-filename/:filename/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = String(req.params.filename);
    const sql = `SELECT id, filename, path FROM books WHERE filename = $1 LIMIT 1`;
    const r = await query(sql, [filename]);
    if ((r.rowCount ?? 0) === 0) {
      res.status(404).json({ error: { message: 'book_not_found' } });
      return;
    }
    const row = r.rows[0] as { id: string; filename: string; path: string };
    const filePath = row.path;
    const fileName = row.filename || `${row.id}.bin`;

    await fs.access(filePath);

    res.download(filePath, fileName, (err?: Error) => {
      if (err) next(err);
    });
  } catch (err: any) {
    if ((err as any).code === 'ENOENT') {
      res.status(404).json({ error: { message: 'file_missing' } });
      return;
    }
    next(err);
  }
});

export default router;