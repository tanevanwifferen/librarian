// src/services/embeddings.ts
// What: OpenAI embedding helpers and shared client.
// How: Initializes OpenAI client and exposes embedText/embedMany using OPENAI_EMBED_MODEL, validating 1536 dims.

import OpenAI from 'openai';
import config from '../config/env.js';

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const EXPECTED_DIMS = 1536;

export async function embedText(text: string): Promise<number[]> {
  const res = await client.embeddings.create({
    model: config.OPENAI_EMBED_MODEL,
    input: text,
  });
  const vec = res.data[0]?.embedding as number[] | undefined;
  if (!vec || vec.length !== EXPECTED_DIMS) {
    throw new Error(`Unexpected embedding size; expected ${EXPECTED_DIMS}, got ${vec?.length ?? 'unknown'}`);
  }
  return vec;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client.embeddings.create({
    model: config.OPENAI_EMBED_MODEL,
    input: texts,
  });
  const vectors = res.data.map((d: any) => d.embedding as number[]);
  for (const v of vectors) {
    if (v.length !== EXPECTED_DIMS) {
      throw new Error(`Unexpected embedding size; expected ${EXPECTED_DIMS}, got ${v.length}`);
    }
  }
  return vectors;
}

export default client;