// src/services/datasetSearch.ts
// What: Shared search helpers with optional dataset filtering.
// How: Provides vector search over chunks with an optional dataset WHERE clause.
//      Used by the unified routes to search local DB subsets or everything.

import { pool } from '../db/pool.js';
import { clampSimilarity, vectorToParam } from '../util/sql.js';

export interface ChunkMatch {
  book_id: string;
  filename: string;
  path: string;
  chunk_index: number;
  distance: number;
  score: number;
  dataset: string;
}

/**
 * Vector search across specified local datasets (or all local if none specified).
 * Pass only non-'arxiv' dataset names; arxiv is handled separately.
 */
export async function searchChunksByDatasets(
  embedding: number[],
  topK: number,
  datasets?: string[]
): Promise<ChunkMatch[]> {
  const qvParam = vectorToParam(embedding);

  // Filter out 'arxiv' — it is an external dataset handled by the caller
  const localDatasets = datasets?.filter((d) => d !== 'arxiv');

  let dsWhere = '';
  const queryParams: any[] = [qvParam, topK];

  if (localDatasets && localDatasets.length > 0) {
    dsWhere = `AND b.dataset = ANY($3)`;
    queryParams.push(localDatasets);
  }

  const sql = `
    WITH top_chunks AS (
      SELECT c.id, c.book_id, c.chunk_index,
             c.embedding <=> $1::vector AS distance
      FROM chunks c
      JOIN books b ON b.id = c.book_id
      WHERE 1=1 ${dsWhere}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2 * 3
    ),
    ranked_chunks AS (
      SELECT tc.*,
             b.id AS b_id, b.filename, b.path, b.dataset,
             ROW_NUMBER() OVER (PARTITION BY tc.book_id ORDER BY tc.distance) AS rn
      FROM top_chunks tc
      JOIN books b ON b.id = tc.book_id
    )
    SELECT id, book_id, chunk_index, distance, b_id, filename, path, dataset
    FROM ranked_chunks
    WHERE rn = 1
    ORDER BY distance
    LIMIT $2;
  `;

  const client = await pool.connect();
  let rows: any[] = [];
  let inTx = false;
  try {
    await client.query('BEGIN');
    inTx = true;
    await client.query('SET LOCAL ivfflat.probes = 10');
    const r = await client.query(sql, queryParams);
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

  return rows.map((row: any) => ({
    book_id: row.b_id as string,
    filename: row.filename as string,
    path: row.path as string,
    chunk_index: Number(row.chunk_index),
    distance: Number(row.distance),
    score: clampSimilarity(Number(row.distance)),
    dataset: row.dataset as string,
  }));
}

/**
 * Fetch the content of specific chunks by book_id/chunk_index pairs for context building.
 */
export async function fetchChunkContents(
  matches: ChunkMatch[]
): Promise<Array<ChunkMatch & { content: string }>> {
  if (matches.length === 0) return [];

  const bookIds = [...new Set(matches.map((m) => m.book_id))];
  const result = await pool.query(
    `SELECT book_id, chunk_index, content FROM chunks WHERE book_id = ANY($1)`,
    [bookIds]
  );

  const contentMap = new Map<string, string>();
  for (const row of result.rows) {
    contentMap.set(`${row.book_id}#${row.chunk_index}`, row.content as string);
  }

  return matches.map((m) => ({
    ...m,
    content: contentMap.get(`${m.book_id}#${m.chunk_index}`) ?? '',
  }));
}
