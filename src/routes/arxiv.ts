// src/routes/arxiv.ts
// What: /arxiv routes for proxying requests to the arXiv search service.
// How: Exposes POST /search for semantic search, POST /chat for RAG-style chat over arXiv,
//      and GET /pdf/:id for PDF retrieval.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { searchArxiv, fetchArxivPdf, ArxivResult } from '../services/arxiv.js';
import openaiClient from '../services/embeddings.js';
import config from '../config/env.js';

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(50).optional().default(5),
});

const router = Router();

router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { query, topK } = parsed.data;
    const matches = await searchArxiv(query, topK);
    res.json({ query, topK, matches });
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'arXiv search unavailable' } });
  }
});

router.get('/pdf/:id(*)', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await fetchArxivPdf(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'Failed to fetch arXiv PDF' } });
  }
});

// --- /chat endpoint: RAG-style chat using arXiv papers as context ---

const MsgSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const chatSchema = z.object({
  messages: z.array(MsgSchema).min(1),
  topK: z.number().int().positive().max(50).optional().default(5),
  temperature: z.number().min(0).max(2).optional().default(1),
});

const QueryGeneratorOutputJSONSchema = {
  name: 'QueryGeneratorOutput',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      technical_query: {
        type: 'string' as const,
        description: 'A technical/specific search query for academic papers.',
      },
      broad_query: {
        type: 'string' as const,
        description: 'A broader/general search query for academic papers.',
      },
    },
    required: ['technical_query', 'broad_query'],
  },
};

async function generateArxivQueries(messages: string, temperature: number) {
  const prompt = `Given the following chat history, generate two search queries for finding relevant academic papers on arXiv:\n\n1. A technical/specific query using precise academic terminology.\n2. A broader/general query covering the topic area.\n\nOutput as JSON:\n{\n  "technical_query": "...",\n  "broad_query": "..."\n}\n\nInput:\n${messages}`;
  const completion = await openaiClient.chat.completions.create({
    model: config.OPENAI_CHAT_MODEL,
    temperature,
    messages: [
      { role: 'system', content: 'You are a search query generator for academic papers.' },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: QueryGeneratorOutputJSONSchema,
    },
    reasoning_effort: 'low',
  });
  try {
    const json = JSON.parse(completion.choices?.[0]?.message?.content ?? '{}');
    return { technical_query: json.technical_query || '', broad_query: json.broad_query || '' };
  } catch {
    return { technical_query: messages, broad_query: messages };
  }
}

router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { messages, topK, temperature } = parsed.data;

    // Step 1: Generate dual search queries
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const { technical_query, broad_query } = await generateArxivQueries(
      lastUserMsg,
      temperature,
    );

    // Step 2: Search arXiv with both queries in parallel
    const [technicalResults, broadResults] = await Promise.all([
      searchArxiv(technical_query, topK),
      searchArxiv(broad_query, topK),
    ]);

    // Step 3: Merge and deduplicate by arxiv_id
    const seen = new Set<string>();
    const mergedResults: ArxivResult[] = [];
    for (const r of [...technicalResults, ...broadResults]) {
      if (!seen.has(r.arxiv_id)) {
        seen.add(r.arxiv_id);
        mergedResults.push(r);
      }
    }

    // Step 4: Build context from abstracts
    const contextBlocks = mergedResults.map(
      (r) => `Paper: ${r.title}\nAuthors: ${r.authors}\narXiv ID: ${r.arxiv_id}\nAbstract: ${r.abstract}`,
    );
    const contextText = contextBlocks.join('\n\n---\n\n').slice(0, 12000);

    const sources = mergedResults.map((r) => ({
      arxiv_id: r.arxiv_id,
      title: r.title,
      authors: r.authors,
      similarity: r.similarity,
    }));

    // Step 5: Call OpenAI with context
    const systemInstruction =
      'You are a helpful scientific research assistant. Use ONLY the provided arXiv paper abstracts to answer the user. ' +
      'Cite papers inline like [arxiv_id]. If the answer is not in the context, say you do not know.';

    const completion = await openaiClient.chat.completions.create({
      model: config.OPENAI_CHAT_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'system', content: `Context:\n${contextText}` },
        ...messages,
      ],
      max_completion_tokens: 1500,
    });

    const answer = completion.choices?.[0]?.message?.content ?? '';

    res.json({
      answer,
      sources,
      used_topK: topK,
      technical_query,
      broad_query,
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      model: config.OPENAI_CHAT_MODEL,
    });
  } catch (err: any) {
    res.status(502).json({ error: { message: err.message ?? 'arXiv chat unavailable' } });
  }
});

export default router;
