// src/services/arxiv.ts
// What: HTTP client for the arXiv semantic search service.
// How: Calls the arXiv FastAPI endpoints for search and PDF retrieval using Node built-in fetch.

import config from '../config/env.js';

const TIMEOUT_MS = 10_000;

export interface ArxivResult {
  arxiv_id: string;
  title: string;
  abstract: string;
  categories: string;
  authors: string;
  similarity: number;
}

export async function searchArxiv(query: string, topN: number): Promise<ArxivResult[]> {
  const url = new URL('/search', config.ARXIV_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('n', String(topN));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`arXiv search returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ArxivResult[];
}

export async function fetchArxivPdf(arxivId: string): Promise<{ arxiv_id: string; pdf_base64: string }> {
  const url = new URL(`/pdf/${arxivId}`, config.ARXIV_SEARCH_URL);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`arXiv PDF fetch returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { arxiv_id: string; pdf_base64: string };
}
