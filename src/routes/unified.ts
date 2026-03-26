// src/routes/unified.ts
// What: Unified search/chat/books/upload endpoints with optional dataset filtering.
// How: Merges local DB results (with optional dataset WHERE clause) and arXiv results.
//      GET /datasets — discover available dataset types.
//      POST /search  — vector search with optional datasets filter.
//      POST /chat    — RAG-style chat with optional datasets filter.
//      GET /books    — list books with optional dataset query param.
//      POST /upload  — upload with required dataset body field.

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { embedText } from '../services/embeddings.js';
import openaiClient from '../services/embeddings.js';
import config from '../config/env.js';
import logger from '../logging.js';
import { searchArxiv, ArxivResult } from '../services/arxiv.js';
import { searchChunksByDatasets, fetchChunkContents } from '../services/datasetSearch.js';
import { handleUpload } from '../services/uploader.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ─── GET /unified/datasets ───────────────────────────────────────────────────

router.get('/datasets', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT dataset FROM books ORDER BY dataset`
    );
    const localDatasets = result.rows.map((row: any) => ({
      name: row.dataset as string,
      type: 'local',
    }));
    // Always include arxiv as an external dataset
    const datasets = [
      ...localDatasets,
      { name: 'arxiv', type: 'external' },
    ];
    res.json({ datasets });
  } catch (err) {
    next(err);
  }
});

// ─── POST /unified/search ─────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(100).optional().default(8),
  datasets: z.array(z.string().min(1)).optional(),
});

router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { query: q, topK, datasets } = parsed.data;

    const includeArxiv = !datasets || datasets.includes('arxiv');
    const includeLocal = !datasets || datasets.some((d) => d !== 'arxiv');

    // Embed query once for local search
    const qv = await embedText(q);

    // Log query
    try {
      await pool.query(
        'INSERT INTO query_logs (id, kind, query_text, top_k) VALUES ($1,$2,$3,$4)',
        [uuidv4(), 'unified_search', q, topK]
      );
    } catch { /* swallow */ }

    // Run local and arxiv searches in parallel
    const [localMatches, arxivMatches] = await Promise.all([
      includeLocal ? searchChunksByDatasets(qv, topK, datasets) : Promise.resolve([]),
      includeArxiv ? searchArxiv(q, topK).catch(() => [] as ArxivResult[]) : Promise.resolve([]),
    ]);

    const matches = [
      ...localMatches.map((m) => ({
        dataset: m.dataset,
        type: 'local' as const,
        book: { id: m.book_id, filename: m.filename, path: m.path },
        chunk_index: m.chunk_index,
        distance: m.distance,
        score: m.score,
      })),
      ...arxivMatches.map((r) => ({
        dataset: 'arxiv',
        type: 'external' as const,
        arxiv_id: r.arxiv_id,
        title: r.title,
        authors: r.authors,
        abstract: r.abstract,
        similarity: r.similarity,
      })),
    ];

    res.json({ query: q, topK, datasets: datasets ?? null, matches });
  } catch (err) {
    next(err);
  }
});

// ─── POST /unified/chat ───────────────────────────────────────────────────────

const MsgSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const chatSchema = z.object({
  messages: z.array(MsgSchema).min(1),
  topK: z.number().int().positive().max(100).optional().default(4),
  temperature: z.number().min(0).max(2).optional().default(1),
  datasets: z.array(z.string().min(1)).optional(),
});

const QueryGeneratorOutputJSONSchema = {
  name: 'QueryGeneratorOutput',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      primary_query: {
        type: 'string' as const,
        description: 'A primary search query for finding relevant content.',
      },
      secondary_query: {
        type: 'string' as const,
        description: 'An alternative phrasing of the same search intent.',
      },
    },
    required: ['primary_query', 'secondary_query'],
  },
};

async function generateSearchQueries(messagesText: string, temperature: number) {
  const prompt = `Given the following chat history, generate two search queries:\n1. A primary query capturing the main intent.\n2. An alternative rephrasing of the same intent.\n\nOutput as JSON:\n{\n  "primary_query": "...",\n  "secondary_query": "..."\n}\n\nInput:\n${messagesText}`;
  const completion = await openaiClient.chat.completions.create({
    model: config.OPENAI_CHAT_MODEL,
    temperature,
    messages: [
      { role: 'system', content: 'You are a search query generator.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: QueryGeneratorOutputJSONSchema },
    reasoning_effort: 'low',
  });
  try {
    const json = JSON.parse(completion.choices?.[0]?.message?.content ?? '{}');
    return {
      primary_query: json.primary_query || messagesText,
      secondary_query: json.secondary_query || messagesText,
    };
  } catch {
    return { primary_query: messagesText, secondary_query: messagesText };
  }
}

router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { messages, topK, temperature, datasets } = parsed.data;

    const includeArxiv = !datasets || datasets.includes('arxiv');
    const includeLocal = !datasets || datasets.some((d) => d !== 'arxiv');

    const messagesText = JSON.stringify(messages);
    const { primary_query, secondary_query } = await generateSearchQueries(messagesText, temperature);

    // Embed both queries
    const [primaryVec, secondaryVec] = await Promise.all([
      embedText(primary_query),
      embedText(secondary_query),
    ]);

    // Search local DB (both queries) and arxiv in parallel
    const [localPrimary, localSecondary, arxivResults] = await Promise.all([
      includeLocal ? searchChunksByDatasets(primaryVec, topK, datasets) : Promise.resolve([]),
      includeLocal ? searchChunksByDatasets(secondaryVec, topK, datasets) : Promise.resolve([]),
      includeArxiv ? searchArxiv(primary_query, topK).catch(() => [] as ArxivResult[]) : Promise.resolve([]),
    ]);

    // Deduplicate local results by filename+chunk_index
    const seenLocal = new Set<string>();
    const mergedLocal = [...localPrimary, ...localSecondary].filter((m) => {
      const key = `${m.filename}#${m.chunk_index}`;
      if (seenLocal.has(key)) return false;
      seenLocal.add(key);
      return true;
    });

    // Fetch chunk content for local results
    const localWithContent = await fetchChunkContents(mergedLocal);

    // Deduplicate arxiv by arxiv_id
    const seenArxiv = new Set<string>();
    const mergedArxiv = arxivResults.filter((r) => {
      if (seenArxiv.has(r.arxiv_id)) return false;
      seenArxiv.add(r.arxiv_id);
      return true;
    });

    // Build context
    const localContextBlocks = localWithContent.map(
      (m) => `Source: [${m.filename}#${m.chunk_index}] (dataset: ${m.dataset})\n${m.content}`
    );
    const arxivContextBlocks = mergedArxiv.map(
      (r) => `Paper: ${r.title}\nAuthors: ${r.authors}\narXiv ID: ${r.arxiv_id}\nAbstract: ${r.abstract}`
    );
    const contextText = [...localContextBlocks, ...arxivContextBlocks]
      .join('\n\n---\n\n')
      .slice(0, 12000);

    const localSources = localWithContent.map((m) => ({
      type: 'local' as const,
      dataset: m.dataset,
      filename: m.filename,
      chunk_index: m.chunk_index,
    }));
    const arxivSources = mergedArxiv.map((r) => ({
      type: 'external' as const,
      dataset: 'arxiv',
      arxiv_id: r.arxiv_id,
      title: r.title,
      authors: r.authors,
      similarity: r.similarity,
    }));
    const sources = [...localSources, ...arxivSources];

    const systemInstruction =
      'You are a helpful assistant. Use ONLY the provided context to answer the user. ' +
      'Cite sources inline like [filename#chunk_index] for local sources or [arxiv_id] for papers. ' +
      'If the answer is not in the context, say you do not know.';

    const completion = await openaiClient.chat.completions.create({
      model: config.OPENAI_CHAT_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'system', content: `Context:\n${contextText}` },
        ...messages,
      ],
      reasoning_effort: 'minimal',
      verbosity: 'medium',
      max_completion_tokens: 1500,
    });

    const answer = completion.choices?.[0]?.message?.content ?? '';

    res.json({
      answer,
      sources,
      used_topK: topK,
      datasets: datasets ?? null,
      primary_query,
      secondary_query,
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      model: config.OPENAI_CHAT_MODEL,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /unified/books ───────────────────────────────────────────────────────

router.get('/books', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dataset = req.query.dataset as string | undefined;
    let sql: string;
    let params: any[];

    if (dataset) {
      sql = `
        SELECT b.id, b.filename, b.path, b.created_at, b.dataset, COALESCE(c.cnt,0) AS chunk_count
        FROM books b
        LEFT JOIN (SELECT book_id, COUNT(*) cnt FROM chunks GROUP BY book_id) c ON c.book_id = b.id
        WHERE b.dataset = $1
        ORDER BY b.created_at DESC
      `;
      params = [dataset];
    } else {
      sql = `
        SELECT b.id, b.filename, b.path, b.created_at, b.dataset, COALESCE(c.cnt,0) AS chunk_count
        FROM books b
        LEFT JOIN (SELECT book_id, COUNT(*) cnt FROM chunks GROUP BY book_id) c ON c.book_id = b.id
        ORDER BY b.created_at DESC
      `;
      params = [];
    }

    const result = await pool.query(sql, params);
    res.json({ items: result.rows, total: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// ─── POST /unified/upload ─────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file provided', status: 'failed_save' });
      return;
    }

    const dataset = req.body?.dataset;
    if (!dataset || typeof dataset !== 'string' || dataset.trim().length === 0) {
      res.status(400).json({ success: false, error: 'dataset field is required', status: 'failed_save' });
      return;
    }

    const { buffer, originalname } = req.file;
    logger.info({ filename: originalname, size: buffer.length, dataset }, 'Unified upload request received');

    const result = await handleUpload(buffer, originalname, dataset.trim());

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(422).json(result);
    }
  } catch (err: any) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ success: false, error: 'File too large. Maximum size is 25MB.', status: 'failed_save' });
        return;
      }
    }
    if (err?.message === 'Only PDF files are allowed') {
      res.status(415).json({ success: false, error: err.message, status: 'failed_save' });
      return;
    }
    next(err);
  }
});

export default router;
