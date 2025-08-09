# PDF Library (Backend-only)

Backend-only Node.js + TypeScript service to index PDFs from a directory, convert to Markdown using Python microsoft/markitdown, chunk, embed with OpenAI text-embedding-3-small (1536 dims), store vectors in Postgres with pgvector, and serve HTTP JSON endpoints for health, listing books, scanning/indexing, semantic search, and RAG chat using gpt-4o.

## Prerequisites

- Node.js >= 18
- Python 3 with microsoft/markitdown installed:
  - pip install microsoft-markitdown
- PostgreSQL >= 15 with pgvector extension
  - Extension install depends on your OS. For Homebrew:
    - brew install postgresql@15
    - brew install pgvector
  - Enable extension in your database:
    - CREATE EXTENSION IF NOT EXISTS vector;

## Setup

1) Copy environment file:
   cp .env.example .env
   - Set DATABASE_URL, OPENAI_API_KEY, and PDF_LIBRARY_DIR to an absolute path.

2) Install dependencies:
   npm install

3) Run migrations (creates tables and indexes):
   npm run migrate

4) Start dev server (watches with tsx):
   npm run dev

Or build and start:
   npm run build
   npm start

Server listens on PORT (default 3000).

## Background scanning

- A persistent background scheduler attempts scans every SCAN_INTERVAL_MS (default 3600000 = 1 hour). It starts on server boot and is also started lazily on the first status/scan call if not already running.
- Each tick only starts a scan if no scan is currently running. If a scan fails or completes, the next tick can start another.

Configuration (env):
- SCAN_INTERVAL_MS: interval between automatic attempts (ms)
- STATUS_LATEST_BOOKS_LIMIT: number of latest books returned by status

Status payload (fields of GET /index/status and POST /index/scan):
- started, interval_ms, is_running, runs_completed
- last_correlation_id, last_run_start, last_run_end, last_run_duration_ms
- last_error, last_result { correlation_id, scanned_count, newly_indexed_count, newly_indexed[], skipped_existing[], failed[], duration_ms }
- next_scheduled_run_at
- latest_books: array of newest books with created_at timestamps
- total_books_in_db
- last_sync_newly_indexed_count
- last_sync_scanned_count

## Endpoints

- GET /health
  - Returns: { "status": "ok" }

- GET /books
  - Lists indexed books with chunk counts.
  - Response: { items: [...], total: number }

- POST /index/scan
  - Ensures the background scan scheduler is running and returns the current status immediately. It does not block to run a full scan; if idle it will kick an immediate attempt in the background.
  - Returns: Background status payload (see "Background scanning" above).

- GET /index/status
  - Returns the current background scan status; also starts the scheduler lazily if needed.

- POST /search
  - Body: { "query": "string", "topK": 8 }
  - Vector search using embeddings with ivfflat.cosine.
  - Returns: {
      query, topK,
      matches: [
        {
          book: { id, filename, path },
          chunk_index, content,
          score,      // similarity in [0,1]
          distance    // cosine distance
        }
      ]
    }

- POST /chat
  - Body:
    {
      "messages": [
        { "role": "user", "content": "..." },
        { "role": "assistant", "content": "..." }
      ],
      "topK": 8,
      "temperature": 0.2
    }
  - Uses last user message as retrieval query. Adds top chunks as context and calls OpenAI gpt-4o.
  - Returns: { answer, sources: [{ filename, chunk_index }], used_topK }

## cURL Examples

- Health:
  curl -s http://localhost:3000/health | jq

- Kick scan and get status:
  curl -s -X POST http://localhost:3000/index/scan | jq

- Status:
  curl -s http://localhost:3000/index/status | jq

- Books:
  curl -s http://localhost:3000/books | jq

- Search:
  curl -s -X POST http://localhost:3000/search \
    -H "Content-Type: application/json" \
    -d '{"query":"neural networks overview", "topK": 8}' | jq

- Chat:
  curl -s -X POST http://localhost:3000/chat \
    -H "Content-Type: application/json" \
    -d '{
      "messages":[{"role":"user","content":"Summarize transformers"}],
      "topK": 8,
      "temperature": 0.2
    }' | jq

## Notes on pgvector

- Ensure the extension exists:
  CREATE EXTENSION IF NOT EXISTS vector;

- We use cosine distance with ivfflat index:
  - Index created with lists=100 (tune to your data size).
  - You can set the number of probes per query for better recall (we use SET LOCAL ivfflat.probes = 10).

## Python/venv for markitdown

- What runs: We execute: `python -m markitdown <file>` using a resolved interpreter.
- Create a venv (POSIX):
  - `python3 -m venv .venv`
  - `source .venv/bin/activate`
  - `pip install markitdown`
- Configuration and precedence:
  - PYTHON_BIN overrides everything else.
  - If PYTHON_BIN is not set, VENV_DIR is used if it points to a valid venv.
  - Otherwise falls back to `python3`, and relies on PATH (your shell may then resolve `python` if `python3` is not present).
- Platform notes:
  - macOS/Linux: `.venv/bin/python3`
  - Windows: `.venv\Scripts\python.exe`
- Environment behavior:
  - When VENV_DIR is used, the child process receives `VIRTUAL_ENV` and a `PATH` where the venv’s bin directory is prepended. We do not “activate” a shell; we set env directly.