// scripts/run-migrations.ts
// What: Simple migration runner to apply SQL files in src/db/migrations.
// How: Loads .env, discovers *.sql files, sorts by filename, and executes each file's SQL via pg
//      using a single connection. Each migration file contains its own BEGIN/COMMIT and IF NOT EXISTS
//      for idempotency. Logs applied files and exits on error.

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), 'src/db/migrations');
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.log('No migrations found.');
    return;
  }

  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  // Debug: print effective DB target without exposing password
  try {
    const u = new URL(connStr);
    const dbName = u.pathname?.replace(/^\//, '') || '';
    const sslParam = u.searchParams.get('ssl') ?? u.searchParams.get('sslmode') ?? 'default';
    console.log('[migrate] Effective DATABASE_URL target:', {
      user: u.username,
      host: u.hostname,
      port: u.port || '5432',
      database: dbName,
      ssl: sslParam,
    });
  } catch (e) {
    console.warn('[migrate] Could not parse DATABASE_URL:', (e as any)?.message ?? e);
  }

  const pool = new Pool({ connectionString: connStr, max: 2 });
  try {
    const client = await pool.connect();
    console.log('[migrate] Connected to database');
    try {
      for (const file of files) {
        const fullPath = path.join(migrationsDir, file);
        const sql = await fs.readFile(fullPath, 'utf8');
        console.log(`Applying migration: ${file}`);
        await client.query(sql);
        console.log(`Applied: ${file}`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log('Migrations complete.');
}

main().catch((err: any) => {
  const code = err?.code;
  const severity = err?.severity;
  const detail = err?.detail || err?.message;
  const hint = err?.hint;
  const routine = err?.routine;
  console.error('[migrate] Migration failed:', { code, severity, detail, hint, routine });
  if (err?.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});