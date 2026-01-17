// src/routes/upload.ts
// What: HTTP endpoint for file uploads.
// How: Uses multer for multipart/form-data handling, validates file type and size,
//      then delegates to the upload service for processing.

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import logger from '../logging.js';
import { handleUpload } from '../services/uploader.js';

const router = Router();

// Configure multer for memory storage (file in buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max
  },
  fileFilter: (_req, file, cb) => {
    // Only accept PDF files
    const isPdf = file.mimetype === 'application/pdf' ||
                  file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// POST /upload - Upload a PDF file
router.post('/', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No file provided',
        status: 'failed_save',
      });
      return;
    }

    const { buffer, originalname } = req.file;

    logger.info({ filename: originalname, size: buffer.length }, 'Upload request received');

    const result = await handleUpload(buffer, originalname);

    // Determine HTTP status based on result
    if (result.success) {
      res.status(200).json(result);
    } else {
      // Return 422 for processing failures (file was received but couldn't be processed)
      res.status(422).json(result);
    }
  } catch (err: any) {
    // Handle multer errors
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          success: false,
          error: 'File too large. Maximum size is 25MB.',
          status: 'failed_save',
        });
        return;
      }
    }

    // Handle our custom error from fileFilter
    if (err?.message === 'Only PDF files are allowed') {
      res.status(415).json({
        success: false,
        error: err.message,
        status: 'failed_save',
      });
      return;
    }

    next(err);
  }
});

export default router;
