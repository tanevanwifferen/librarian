// src/server.ts
// What: HTTP server entrypoint.
// How: Initializes env and logger, creates Express app with JSON body limit, mounts routes,
//      starts the background scan scheduler on boot, sets centralized error handler returning
//      { error: { message, code? } }, and listens on configured port.

import express, { NextFunction, Request, Response } from 'express';
import config from './config/env.js';
import logger from './logging.js';
import router from './routes/index.js';
import { ensureScanSchedulerStarted } from './services/scanScheduler.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/', router);

// Start background scan scheduler on server boot
ensureScanSchedulerStarted();

// Centralized error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status ?? 500;
  const code = err?.code;
  const message = err?.message ?? 'Internal Server Error';
  logger.error({ err, status, code }, 'Unhandled error');
  res.status(status).json({ error: { message, code } });
});

const port = Number(config.PORT);
app.listen(port, () => {
  logger.info({ port }, 'Server listening');
});