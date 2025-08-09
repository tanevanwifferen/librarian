/**
 * src/services/markitdown.ts
 * What: Convert a PDF file to Markdown using Python microsoft/markitdown.
 * How: Spawns PYTHON_BIN with "-m markitdown <file>", may inject venv env via config.PYTHON_ENV,
 *      enforces timeout and max stdout size (50MB), captures stdout as Markdown,
 *      and throws a typed error including stderr excerpt on failures.
 *      See also [convertPdfToMarkdown()](src/services/markitdown.ts:27).
 */

import { spawn } from 'child_process';
import config from '../config/env.js';

export type MarkitDownErrorCode = 'EXIT_NON_ZERO' | 'TIMEOUT' | 'SIZE_EXCEEDED';

export class MarkitDownError extends Error {
  code: MarkitDownErrorCode;
  stderr?: string;
  constructor(code: MarkitDownErrorCode, message: string, stderr?: string) {
    super(message);
    this.name = 'MarkitDownError';
    this.code = code;
    this.stderr = stderr;
  }
}

interface ConvertOptions {
  timeoutMs?: number; // default 300_000
  maxBytes?: number;  // default 50MB
}

export async function convertPdfToMarkdown(filePath: string, opts: ConvertOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000; // 5 minutes
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024; // 50 MB
  return new Promise((resolve, reject) => {
    const proc = spawn(config.PYTHON_BIN, ['-m', 'markitdown', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.PYTHON_ENV ?? {}) },
    });

    let stdoutBytes = 0;
    const stdoutChunks: any[] = [];
    const stderrChunks: any[] = [];

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new MarkitDownError('TIMEOUT', `markitdown timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: any) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        try { proc.kill('SIGKILL'); } catch {}
        clearTimeout(timer);
        reject(new MarkitDownError('SIZE_EXCEEDED', `markitdown output exceeded ${maxBytes} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: any) => {
      stderrChunks.push(chunk);
    });

    proc.on('error', (err: any) => {
      clearTimeout(timer);
      reject(new MarkitDownError('EXIT_NON_ZERO', `Failed to spawn markitdown: ${err?.message ?? String(err)}`));
    });

    proc.on('close', (code: any) => {
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new MarkitDownError('EXIT_NON_ZERO', `markitdown exited with code ${code}`, stderrText.slice(0, 2000)));
      } else {
        const md = Buffer.concat(stdoutChunks).toString('utf8');
        resolve(md);
      }
    });
  });
}