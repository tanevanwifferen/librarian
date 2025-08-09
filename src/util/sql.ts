// src/util/sql.ts
// What: SQL helpers for vectors and scoring.
// How: vectorToParam formats an array for ::vector casting; clampSimilarity converts distance to [0,1].

export function vectorToParam(v: number[]): string {
  // Postgres vector literal: [0.1, 0.2, ...]
  return `[${v.join(',')}]`;
}

export function clampSimilarity(distance: number): number {
  const sim = 1 - distance;
  if (sim < 0) return 0;
  if (sim > 1) return 1;
  return sim;
}