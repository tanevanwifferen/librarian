/**
 * src/config/env.ts
 * What: Environment configuration loader/validator with venv-aware Python interpreter resolution.
 * How: Loads .env via dotenv, validates with zod, and then computes the final Python interpreter and optional
 *      environment overlay for child processes:
 *        - If process.env.PYTHON_BIN is set and non-empty: use it exactly. Do NOT set VIRTUAL_ENV or modify PATH.
 *        - Else if process.env.VENV_DIR points to a valid venv (platform-aware python path exists): use it and set
 *          PYTHON_ENV overlay with VIRTUAL_ENV and PATH (venv bin dir prepended). We do not "activate" a shell.
 *        - Else default to "python3" and rely on PATH resolution at spawn time. We do not perform which-like checks.
 *      Note: When VENV_DIR is relative, it is resolved against process.cwd() (project root at runtime).
 */

import 'dotenv/config';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const intWithDefault = (def: number) =>
  z.preprocess(
    (v: unknown) => (typeof v === 'string' ? parseInt(v as string, 10) : v),
    z.number().int().positive().default(def),
  );

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  PDF_LIBRARY_DIR: z.string().min(1, 'PDF_LIBRARY_DIR is required'),
  // Keep PYTHON_BIN in the schema for backwards compatibility; final selection is computed below.
  PYTHON_BIN: z.string().min(1).default('python3'),
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o'),
  INDEX_CONCURRENCY: intWithDefault(2),
  PORT: intWithDefault(3000),
  SCAN_INTERVAL_MS: intWithDefault(60 * 60 * 1000),
  STATUS_LATEST_BOOKS_LIMIT: intWithDefault(10),
  NODE_ENV: z.enum(['production', 'development', 'test']).optional().default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

// Manual interface to avoid relying on zod's type-level helpers during bootstrap
export interface AppConfig {
  DATABASE_URL: string;
  OPENAI_API_KEY: string;
  PDF_LIBRARY_DIR: string;
  PYTHON_BIN: string; // Final resolved Python interpreter used for markitdown
  OPENAI_EMBED_MODEL: string;
  OPENAI_CHAT_MODEL: string;
  INDEX_CONCURRENCY: number;
  PORT: number;
  SCAN_INTERVAL_MS: number;
  STATUS_LATEST_BOOKS_LIMIT: number;
  NODE_ENV?: 'production' | 'development' | 'test';
  // Optional environment overlay applied only when a venv interpreter is selected from VENV_DIR.
  PYTHON_ENV?: Record<string, string>;
}

// Start with parsed environment, then compute Python resolution precedence.
const base = parsed.data;

// Read raw envs directly for precedence decisions (do not rely on zod default for PYTHON_BIN here).
const rawPythonBin = (process.env.PYTHON_BIN ?? '').trim();
const rawVenvDir = (process.env.VENV_DIR ?? '').trim();

// Platform detection
const isWin = process.platform === 'win32';

// Resolve VENV_DIR to absolute path when provided. If relative, resolve against process.cwd().
const venvDirAbs =
  rawVenvDir.length > 0
    ? (path.isAbsolute(rawVenvDir) ? rawVenvDir : path.resolve(process.cwd(), rawVenvDir))
    : undefined;

// Compute final interpreter and optional env overlay.
let finalPythonBin = 'python3'; // Default to python3; rely on PATH at runtime for actual resolution.
let pythonEnv: Record<string, string> | undefined;

if (rawPythonBin) {
  // Explicit interpreter provided; use as-is without any environment overlay.
  finalPythonBin = rawPythonBin;
} else if (venvDirAbs) {
  // Try to find a python interpreter inside the venv directory (platform-aware).
  const venvBinDir = isWin ? path.join(venvDirAbs, 'Scripts') : path.join(venvDirAbs, 'bin');
  const candidates = isWin
    ? [path.join(venvBinDir, 'python.exe')]
    : [path.join(venvBinDir, 'python3'), path.join(venvBinDir, 'python')];

  const found = candidates.find((p) => fs.existsSync(p));
  if (found) {
    finalPythonBin = found;
    pythonEnv = {
      VIRTUAL_ENV: venvDirAbs,
      PATH: `${venvBinDir}${path.delimiter}${process.env.PATH || ''}`,
    };
  }
  // If not found, fall through to default "python3" with no overlay.
} else {
  // No PYTHON_BIN and no usable VENV_DIR; keep "python3" and rely on PATH. We do not explicitly try "python".
}

// Build final config object, preserving existing exports and adding PYTHON_ENV.
const config: AppConfig = {
  ...base,
  PYTHON_BIN: finalPythonBin,
  PYTHON_ENV: pythonEnv, // Only defined when venv-selected interpreter is used.
};

export default config;