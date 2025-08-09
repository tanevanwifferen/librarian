// src/services/scanScheduler.ts
// What: Persistent background scheduler for library scanning.
// How: Maintains a singleton loop that attempts to run a scan at a fixed interval (default hourly).
//      The loop only launches a new scan when not currently running, so it naturally "restarts"
//      on the next tick if the previous run ended or crashed. Exposes status and latest books.

import logger from '../logging.js';
import { pool } from '../db/pool.js';
import config from '../config/env.js';
import { newCorrelationId, runScan, ScanResult } from './indexer.js';

type LatestBook = {
  id: string;
  filename: string;
  path: string;
  created_at: string; // ISO
};

export interface BackgroundScanStatus {
  started: boolean;
  interval_ms: number;
  is_running: boolean;
  last_correlation_id?: string;
  last_run_start?: string; // ISO
  last_run_end?: string;   // ISO
  last_run_duration_ms?: number;
  runs_completed: number;
  last_error?: string;
  last_result?: Omit<ScanResult, 'correlation_id'> & { correlation_id: string };
  next_scheduled_run_at?: string; // ISO (approximation, based on the last tick time)
  latest_books: LatestBook[];
  // Aggregates for visibility
  total_books_in_db: number;
  last_sync_newly_indexed_count?: number;
  last_sync_scanned_count?: number;
}

let started = false;
let isRunning = false;
let runsCompleted = 0;

let lastCorrelationId: string | undefined;
let lastRunStart: number | undefined;
let lastRunEnd: number | undefined;
let lastRunDurationMs: number | undefined;
let lastError: string | undefined;
let lastResult: ScanResult | undefined;

let timer: NodeJS.Timeout | null = null;
let lastTickAt = Date.now();

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const INTERVAL_MS = Number(config.SCAN_INTERVAL_MS ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
const LATEST_BOOKS_LIMIT = Number(config.STATUS_LATEST_BOOKS_LIMIT ?? 10) || 10;

/**
 * Attempt to start a scan if one is not currently running.
 * Called by the timer tick and can be called manually.
 */
async function attemptRunIfIdle(): Promise<void> {
  if (isRunning) {
    return;
  }
  isRunning = true;
  lastError = undefined;
  const correlationId = newCorrelationId();
  lastCorrelationId = correlationId;
  lastRunStart = Date.now();

  logger.info({ correlationId }, 'Background scan starting');

  try {
    const result = await runScan(correlationId);
    lastResult = result;
    logger.info({ correlationId, result }, 'Background scan finished');
  } catch (err: any) {
    lastError = err?.message ?? 'Unknown error';
    logger.error({ err, correlationId }, 'Background scan failed');
  } finally {
    lastRunEnd = Date.now();
    lastRunDurationMs = lastRunStart ? lastRunEnd - lastRunStart : undefined;
    isRunning = false;
    runsCompleted += 1;
  }
}

/**
 * Timer callback that attempts to run a scan if idle.
 */
async function tick(): Promise<void> {
  lastTickAt = Date.now();
  try {
    await attemptRunIfIdle();
  } catch (err) {
    // extra guardrail: never let the timer crash
    logger.error({ err }, 'Scheduler tick failed');
  }
}

/**
 * Start the background scheduler if it is not already running.
 * This sets up a periodic timer that tries to run a scan at the configured cadence.
 */
export function ensureScanSchedulerStarted(): void {
  if (started) return;
  started = true;

  // Perform an immediate tick on startup to "kick" the loop without blocking the request.
  void tick();

  // Then set an interval to try again each interval. If a scan is already running, the attempt is skipped.
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  logger.info({ interval_ms: INTERVAL_MS }, 'Scan scheduler started');
}

/**
 * Stop the scheduler (not exposed publicly, but useful for tests if needed).
 */
function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

/**
 * Fetch latest books from the DB, ordered by created_at desc.
 */
async function fetchLatestBooks(limit: number): Promise<LatestBook[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, filename, path, created_at
       FROM books
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      filename: r.filename,
      path: r.path,
      created_at: new Date(r.created_at).toISOString(),
    }));
  } finally {
    client.release();
  }
}

/**
 * Fetch totals such as total books in DB.
 */
async function fetchTotals(): Promise<{ total_books: number }> {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT COUNT(*)::int AS count FROM books');
    const total = (res.rows?.[0]?.count as number) ?? 0;
    return { total_books: total };
  } finally {
    client.release();
  }
}

/**
 * Get current scheduler status, including latest books.
 */
export async function getScanStatus(): Promise<BackgroundScanStatus> {
  const latest_books = await fetchLatestBooks(LATEST_BOOKS_LIMIT);
  const { total_books } = await fetchTotals();
  const nextScheduled = new Date((lastTickAt ?? Date.now()) + INTERVAL_MS).toISOString();

  return {
    started,
    interval_ms: INTERVAL_MS,
    is_running: isRunning,
    last_correlation_id: lastCorrelationId,
    last_run_start: lastRunStart ? new Date(lastRunStart).toISOString() : undefined,
    last_run_end: lastRunEnd ? new Date(lastRunEnd).toISOString() : undefined,
    last_run_duration_ms: lastRunDurationMs,
    runs_completed: runsCompleted,
    last_error: lastError,
    last_result: lastResult
      ? {
          correlation_id: lastResult.correlation_id,
          scanned_count: lastResult.scanned_count,
          newly_indexed_count: lastResult.newly_indexed_count,
          newly_indexed: lastResult.newly_indexed,
          skipped_existing: lastResult.skipped_existing,
          failed: lastResult.failed,
          duration_ms: lastResult.duration_ms,
        }
      : undefined,
    next_scheduled_run_at: nextScheduled,
    latest_books,
    total_books_in_db: total_books,
    last_sync_newly_indexed_count: lastResult?.newly_indexed_count,
    last_sync_scanned_count: lastResult?.scanned_count,
  };
}

// Optional: graceful shutdown handling (in case you wire it in server bootstrap)
process.on('beforeExit', () => {
  stopScheduler();
});