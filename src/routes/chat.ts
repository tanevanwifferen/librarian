// src/routes/chat.ts
// What: /chat route for RAG-style chat using OpenAI gpt-4o.
// How: Validates input, embeds last user message for retrieval, fetches topK chunks (ivfflat with probes),
//      builds a system+context prompt, and calls OpenAI chat completions. The DB transaction is limited strictly
//      to SET LOCAL + SELECT and guarded with an inTx flag to avoid ROLLBACK when no transaction is active.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import openaiClient from '../services/embeddings.js';
import config from '../config/env.js';
import { embedText } from '../services/embeddings.js';
import { vectorToParam } from '../util/sql.js';

const MsgSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const schema = z.object({
  messages: z.array(MsgSchema).min(1),
  topK: z.number().int().positive().max(100).optional().default(8),
  temperature: z.number().min(0).max(2).optional().default(0.2),
});

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { messages, topK, temperature } = parsed.data;

    // Last user message as retrieval query
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const retrievalQuery = lastUser?.content?.trim() || messages[messages.length - 1].content;

    // Embed query
    const qv = await embedText(retrievalQuery);
    const qvParam = vectorToParam(qv);

    // Retrieve topK chunks by cosine distance
    const client = await pool.connect();
    let rows: any[] = [];
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      await client.query('SET LOCAL ivfflat.probes = 10');
      const sql = `
        WITH q AS (SELECT $1::vector AS qv)
        SELECT c.id, c.book_id, c.chunk_index, c.content, (c.embedding <=> q.qv) AS distance,
               b.id AS b_id, b.filename, b.path
        FROM chunks c
        JOIN books b ON b.id = c.book_id, q
        ORDER BY c.embedding <=> q.qv
        LIMIT $2
      `;
      const r = await client.query(sql, [qvParam, topK]);
      rows = r.rows;
      await client.query('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw err;
    } finally {
      client.release();
    }

    const sources = rows.map((row) => ({
      filename: String(row.filename),
      chunk_index: Number(row.chunk_index),
    }));

    const contextBlocks = rows.map(
      (row) => `Source: [${row.filename}#${row.chunk_index}]\n${row.content}`,
    );
    const contextText = contextBlocks.join('\n\n---\n\n').slice(0, 12000); // guard context size

    const systemInstruction =
      'You are a helpful assistant. Use ONLY the provided context to answer the user. ' +
      'Cite sources inline like [filename#chunk_index]. If the answer is not in the context, say you do not know.';

    const completion = await openaiClient.chat.completions.create({
      model: config.OPENAI_CHAT_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'system', content: `Context:\n${contextText}` },
        ...messages,
      ],
      reasoning_effort: 'low',
      verbosity: 'low'
    });

    const answer = completion.choices?.[0]?.message?.content ?? '';

    res.json({
      answer,
      sources,
      used_topK: topK,
    });
  } catch (err) {
    next(err);
  }
});

export default router;