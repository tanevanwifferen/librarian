// src/routes/arxiv.ts
// What: /arxiv routes for proxying requests to the arXiv search service.
// How: Exposes POST /search for semantic search and GET /pdf/:id for PDF retrieval.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { searchArxiv, fetchArxivPdf } from '../services/arxiv.js';

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(50).optional().default(5),
});

const router = Router();

router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { query, topK } = parsed.data;
    const matches = await searchArxiv(query, topK);
    res.json({ query, topK, matches });
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'arXiv search unavailable' } });
  }
});

router.get('/pdf/:id(*)', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await fetchArxivPdf(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'Failed to fetch arXiv PDF' } });
  }
});

export default router;
