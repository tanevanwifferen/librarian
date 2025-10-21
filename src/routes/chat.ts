// src/routes/chat.ts
// What: /chat route for RAG-style chat using OpenAI gpt-4o.
// How: Validates input, embeds last user message for retrieval, fetches topK chunks (ivfflat with probes),
//      builds a system+context prompt, and calls OpenAI chat completions. The DB transaction is limited strictly
//      to SET LOCAL + SELECT and guarded with an inTx flag to avoid ROLLBACK when no transaction is active.

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import openaiClient from "../services/embeddings.js";
import config from "../config/env.js";
import { embedText } from "../services/embeddings.js";
import { vectorToParam } from "../util/sql.js";
import { v4 as uuidv4 } from "uuid";
import { JSONSchema } from "zod/v4/core";

const MsgSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const schema = z.object({
  messages: z.array(MsgSchema).min(1),
  topK: z.number().int().positive().max(100).optional().default(4),
  temperature: z.number().min(0).max(2).optional().default(1),
});

const QueryGeneratorOutput = z.object({
  occult_query: z.string(),
  earthly_query: z.string(),
});

const router = Router();

// Helper: Generate occult and earthly queries from message history
async function generateSearchQueries(messages: string, temperature: number) {
  // Use OpenAI to generate both queries in a structured output
  const prompt = `Given the following chat history, generate two search queries:\n\n1. An occult vocabulary version, suitable for esoteric retrieval.\n2. An earthly vocabulary version, suitable for regular retrieval.\n\nOutput as JSON:\n{\n  "occult_query": "...",
  "earthly_query": "..."
}\n\nInput:\n${messages}`;
  const completion = await openaiClient.chat.completions.create({
    model: config.OPENAI_CHAT_MODEL,
    temperature,
    messages: [
      { role: "system", content: "You are a search query generator." },
      { role: "user", content: prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: QueryGeneratorOutput,
    },
    reasoning_effort: "low",
    verbosity: "low",
  });
  let occult_query = "";
  let earthly_query = "";
  try {
    const json = JSON.parse(completion.choices?.[0]?.message?.content ?? "{}");
    occult_query = json.occult_query || "";
    earthly_query = json.earthly_query || "";
  } catch {
    // fallback: use last user message
    earthly_query = messages;
    occult_query = messages;
  }
  return { occult_query, earthly_query };
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message } });
      return;
    }
    const { messages, topK, temperature } = parsed.data;

    // Step 1: Generate occult and earthly queries
    const { occult_query, earthly_query } = await generateSearchQueries(
      typeof messages === "string" ? messages : JSON.stringify(messages),
      temperature
    );

    // Step 2: Embed both queries
    const [occultVec, earthlyVec] = await Promise.all([
      embedText(occult_query),
      embedText(earthly_query),
    ]);
    const occultParam = vectorToParam(occultVec);
    const earthlyParam = vectorToParam(earthlyVec);

    // Step 3: Log both queries
    try {
      const logId = uuidv4();
      await pool.query(
        "INSERT INTO query_logs (id, kind, query_text, embedding, top_k, temperature) VALUES ($1,$2,$3,$4::vector,$5,$6)",
        [logId, "chat-occult", occult_query, occultParam, topK, temperature]
      );
      const logId2 = uuidv4();
      await pool.query(
        "INSERT INTO query_logs (id, kind, query_text, embedding, top_k, temperature) VALUES ($1,$2,$3,$4::vector,$5,$6)",
        [logId2, "chat-earthly", earthly_query, earthlyParam, topK, temperature]
      );
    } catch {}

    // Step 4: Retrieve topK chunks for both queries
    const client = await pool.connect();
    let rowsOccult: any[] = [];
    let rowsEarthly: any[] = [];
    let inTx = false;
    try {
      await client.query("BEGIN");
      inTx = true;
      await client.query("SET LOCAL ivfflat.probes = 10");
      const sql = `
        WITH q AS (SELECT $1::vector AS qv)
        SELECT c.id, c.book_id, c.chunk_index, c.content, (c.embedding <=> q.qv) AS distance,
               b.id AS b_id, b.filename, b.path
        FROM chunks c
        JOIN books b ON b.id = c.book_id, q
        ORDER BY c.embedding <=> q.qv
        LIMIT $2
      `;
      // Occult
      const rOccult = await client.query(sql, [occultParam, topK]);
      rowsOccult = rOccult.rows;
      // Earthly
      const rEarthly = await client.query(sql, [earthlyParam, topK]);
      rowsEarthly = rEarthly.rows;
      await client.query("COMMIT");
      inTx = false;
    } catch (err) {
      if (inTx) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }
      throw err;
    } finally {
      client.release();
    }

    // Step 5: Merge results (deduplicate by filename+chunk_index)
    const allRows = [...rowsOccult, ...rowsEarthly];
    const seen = new Set();
    const mergedRows = allRows.filter((row) => {
      const key = `${row.filename}#${row.chunk_index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const sources = mergedRows.map((row) => ({
      filename: String(row.filename),
      chunk_index: Number(row.chunk_index),
    }));

    const contextBlocks = mergedRows.map(
      (row) => `Source: [${row.filename}#${row.chunk_index}]\n${row.content}`
    );
    const contextText = contextBlocks.join("\n\n---\n\n").slice(0, 12000); // guard context size

    const systemInstruction =
      "You are a helpful assistant. Use ONLY the provided context to answer the user. " +
      "Cite sources inline like [filename#chunk_index]. If the answer is not in the context, say you do not know.";

    const completion = await openaiClient.chat.completions.create({
      model: config.OPENAI_CHAT_MODEL,
      temperature,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "system", content: `Context:\n${contextText}` },
        ...messages,
      ],
      reasoning_effort: "low",
      verbosity: "medium",
    });

    const answer = completion.choices?.[0]?.message?.content ?? "";

    res.json({
      answer,
      sources,
      used_topK: topK,
      occult_query,
      earthly_query,
      input_tokens: completion.usage.prompt_tokens,
      output_tokens: completion.usage.completion_tokens,
      model: config.OPENAI_CHAT_MODEL,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
