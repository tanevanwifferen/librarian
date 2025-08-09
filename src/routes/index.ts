// src/routes/index.ts
// What: Root router composition.
// How: Exposes /health, mounts /books, /search, /chat, provides POST /index/scan (kick + status) and GET /index/status.
//      Lazily ensures background scan scheduler is running to persist scans and report status incl. latest books.

import { Router, Request, Response, NextFunction } from 'express';
import booksRouter from './books.js';
import searchRouter from './search.js';
import chatRouter from './chat.js';
import { ensureScanSchedulerStarted, getScanStatus } from '../services/scanScheduler.js';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

router.post('/index/scan', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Ensure the background scheduler is running; it will kick an immediate attempt if idle
    ensureScanSchedulerStarted();
    const status = await getScanStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});
 
router.get('/index/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Lazily ensure the scheduler is started on status queries as well
    ensureScanSchedulerStarted();
    const status = await getScanStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});
 
router.use('/books', booksRouter);
router.use('/search', searchRouter);
router.use('/chat', chatRouter);

export default router;