// src/models/types.ts
// What: Shared TypeScript types for DB entities and DTOs used by routes/services.
// How: Interfaces mirror DB columns; additional DTOs for API responses.

export interface Book {
  id: string;
  filename: string;
  path: string;
  created_at: string; // ISO timestamp
}

export interface Chunk {
  id: string;
  book_id: string;
  chunk_index: number;
  content: string;
  created_at: string; // ISO timestamp
}

export interface SearchMatch {
  book: { id: string; filename: string; path: string };
  chunk_index: number;
  content: string;
  score: number; // [0,1]
  distance: number; // cosine distance
}