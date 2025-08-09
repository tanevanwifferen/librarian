// src/db/pool.ts
// What: Shared Postgres connection pool and query helper.
// How: Initializes pg Pool using DATABASE_URL with a small pool size and exports pool & query().

import { Pool } from 'pg';
import config from '../config/env.js';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Return loose any to avoid generic type arg issues before types are installed
export function query(text: string, params?: any[]): Promise<any> {
  return pool.query(text, params as any[]);
}