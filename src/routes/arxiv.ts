// src/routes/arxiv.ts
// What: /arxiv routes for proxying requests to the arXiv search service.
// How: Exposes GET /pdf/:id that proxies to the arXiv FastAPI PDF endpoint.

import { Router, Request, Response, NextFunction } from 'express';
import { fetchArxivPdf } from '../services/arxiv.js';

const router = Router();

router.get('/pdf/:id(*)', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await fetchArxivPdf(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'Failed to fetch arXiv PDF' } });
  }
});

export default router;
