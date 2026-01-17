// src/services/uploader.ts
// What: Handles file uploads - computes hash, saves file, triggers indexing.
// How: Computes SHA256 hash for duplicate detection, sanitizes filename,
//      saves to UPLOAD_DIR, then calls indexSingleFile for processing.

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import config from '../config/env.js';
import logger from '../logging.js';
import { indexSingleFile, SingleFileResult } from './indexer.js';

/**
 * Compute SHA256 hash of a buffer.
 */
export function computeFileHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Sanitize filename to prevent path traversal and ensure valid characters.
 * - Removes path components (/, \)
 * - Limits length to 200 characters
 * - Replaces problematic characters
 */
export function sanitizeFilename(name: string): string {
  // Remove any path components
  let sanitized = path.basename(name);

  // Replace problematic characters
  sanitized = sanitized.replace(/[<>:"|?*\x00-\x1f]/g, '_');

  // Limit length (preserve extension)
  const ext = path.extname(sanitized);
  const base = path.basename(sanitized, ext);
  const maxBaseLen = 200 - ext.length;

  if (base.length > maxBaseLen) {
    sanitized = base.substring(0, maxBaseLen) + ext;
  }

  return sanitized;
}

export interface UploadResult {
  success: boolean;
  book_id?: string;
  filename: string;
  chunks_count?: number;
  status: 'indexed' | 'already_exists' | 'failed_parse' | 'failed_embed' | 'failed_insert' | 'failed_save';
  error?: string;
}

/**
 * Handle an uploaded file:
 * 1. Compute hash for duplicate detection
 * 2. Save to UPLOAD_DIR
 * 3. Run indexing pipeline
 */
export async function handleUpload(
  buffer: Buffer,
  originalFilename: string
): Promise<UploadResult> {
  const filename = sanitizeFilename(originalFilename);
  const fileHash = computeFileHash(buffer);

  logger.info({ filename, hash: fileHash }, 'Processing upload');

  // Ensure upload directory exists
  try {
    await fs.mkdir(config.UPLOAD_DIR, { recursive: true });
  } catch (err: any) {
    logger.error({ err, dir: config.UPLOAD_DIR }, 'Failed to create upload directory');
    return {
      success: false,
      filename,
      status: 'failed_save',
      error: 'Failed to create upload directory',
    };
  }

  // Build target path
  const targetPath = path.join(config.UPLOAD_DIR, filename);

  // Check if file already exists on disk (different from DB check)
  try {
    await fs.access(targetPath);
    // File exists - indexSingleFile will handle the duplicate check via hash
    logger.info({ filename, path: targetPath }, 'File already exists on disk, checking database');
  } catch {
    // File doesn't exist, save it
    try {
      await fs.writeFile(targetPath, buffer);
      logger.info({ filename, path: targetPath }, 'Saved uploaded file');
    } catch (err: any) {
      logger.error({ err, path: targetPath }, 'Failed to save uploaded file');
      return {
        success: false,
        filename,
        status: 'failed_save',
        error: `Failed to save file: ${err?.message ?? 'Unknown error'}`,
      };
    }
  }

  // Run the indexing pipeline
  const result: SingleFileResult = await indexSingleFile(targetPath, filename, fileHash);

  return {
    success: result.success,
    book_id: result.book_id,
    filename: result.filename,
    chunks_count: result.chunks_count,
    status: result.status,
    error: result.error,
  };
}
