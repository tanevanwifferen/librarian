// src/services/scanner.ts
// What: Filesystem scanner for PDFs.
// How: Recursively walks PDF_LIBRARY_DIR (from env) and returns an array of { filename, path } with absolute paths for .pdf files.

import fs from 'fs/promises';
import path from 'path';
import config from '../config/env.js';

export interface ScannedFile {
  filename: string;
  path: string; // absolute path
}

export async function scanLibrary(): Promise<ScannedFile[]> {
  const root = config.PDF_LIBRARY_DIR;
  const out: ScannedFile[] = [];
  await walk(root, out);
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function walk(dir: string, acc: ScannedFile[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, acc);
    } else if (e.isFile()) {
      if (e.name.toLowerCase().endsWith('.pdf')) {
        acc.push({ filename: e.name, path: full });
      }
    }
  }
}