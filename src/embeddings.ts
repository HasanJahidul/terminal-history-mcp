import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LlmError, type EmbedFn } from "./llm.js";

export const EMBED_BATCH_SIZE = 64;
export const DEFAULT_REINDEX_LIMIT = 2000;
// Very long commands (heredocs, pasted scripts) are cut before embedding so one entry
// cannot exceed the model's context window and fail its whole batch forever.
const MAX_EMBED_CHARS = 2000;

// One row per (distinct command text, model). Identical commands run many times share
// a vector; storing the model means switching models re-embeds instead of mixing spaces.
// entry_id points at the most recent commands.id that had this text when it was embedded.
export function ensureEmbeddingsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_embeddings (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      entry_id INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (content_hash, model)
    );
    CREATE INDEX IF NOT EXISTS idx_emb_model ON command_embeddings(model, dims);
  `);
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// Float32, platform byte order (little-endian on every platform Node ships for).
export function encodeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  if (buf.byteLength % 4 !== 0) throw new Error(`corrupt vector blob (${buf.byteLength} bytes)`);
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  // Float32Array views must be 4-byte aligned; copy when the Buffer is not.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) throw new Error("cannot normalise a zero or non-finite vector");
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`dimension mismatch ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function countEmbeddings(db: Database.Database, model: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM command_embeddings WHERE model = ?`).get(model) as { c: number };
  return row.c;
}

export type VectorHit = { content_hash: string; entry_id: number; similarity: number };

// Exact brute-force k-NN: one linear scan over every stored vector for the model. Vectors are
// L2-normalised on write, so the dot product IS the cosine similarity. Cost per query is
// O(N·d) plus reading N BLOBs out of SQLite; `npm run eval` measures it at 10k and 100k
// vectors (see docs/adr/0001-semantic-search.md). That is fine for one person's history
// (10^4-10^5 distinct commands). Past that ceiling, replace this loop with the sqlite-vec
// extension (vec0 virtual table, KNN in C, same DB file) rather than tuning it.
export function vectorSearch(db: Database.Database, query: Float32Array, model: string, k: number): VectorHit[] {
  if (k <= 0) return [];
  const stmt = db.prepare(
    `SELECT content_hash, entry_id, vector FROM command_embeddings WHERE model = ? AND dims = ?`,
  );
  const d = query.length;
  const top: VectorHit[] = []; // sorted by similarity, descending
  for (const row of stmt.iterate(model, d) as IterableIterator<{ content_hash: string; entry_id: number; vector: Buffer }>) {
    const v = decodeVector(row.vector);
    let s = 0;
    for (let i = 0; i < d; i++) s += query[i] * v[i];
    if (top.length === k && s <= top[k - 1].similarity) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].similarity < s) pos--;
    top.splice(pos, 0, { content_hash: row.content_hash, entry_id: row.entry_id, similarity: s });
    if (top.length > k) top.pop();
  }
  return top;
}

export type ReindexEmbeddingsResult = {
  model: string;
  embedded: number;   // vectors written this run
  skipped: number;    // distinct texts already embedded for this model (or blank)
  failed: number;     // texts in batches the endpoint rejected this run
  remaining: number;  // distinct texts still without a vector for this model
  error?: string;     // first error seen, if any
};

export async function reindexEmbeddings(
  db: Database.Database,
  embed: EmbedFn,
  model: string,
  limit: number = DEFAULT_REINDEX_LIMIT,
): Promise<ReindexEmbeddingsResult> {
  // Text comes from the DB, i.e. after redaction at insert time. Most recent text first, so
  // a partial run (limit) covers the commands people are most likely to search for.
  const distinct = db.prepare(
    `SELECT MAX(id) AS id, cmd FROM commands GROUP BY cmd ORDER BY MAX(id) DESC`,
  ).all() as Array<{ id: number; cmd: string }>;
  const have = new Set(
    db.prepare(`SELECT content_hash FROM command_embeddings WHERE model = ?`).pluck().all(model) as string[],
  );

  let skipped = 0;
  const pending: Array<{ id: number; cmd: string; hash: string }> = [];
  for (const r of distinct) {
    const hash = contentHash(r.cmd);
    if (!r.cmd.trim() || have.has(hash)) { skipped++; continue; }
    pending.push({ id: r.id, cmd: r.cmd, hash });
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO command_embeddings (content_hash, model, dims, entry_id, vector) VALUES (?, ?, ?, ?, ?)`,
  );
  const write = db.transaction((rows: Array<{ hash: string; id: number; vec: Float32Array }>) => {
    for (const r of rows) insert.run(r.hash, model, r.vec.length, r.id, encodeVector(r.vec));
  });

  const todo = pending.slice(0, Math.max(0, limit));
  let embedded = 0, failed = 0;
  let error: string | undefined;
  for (let i = 0; i < todo.length; i += EMBED_BATCH_SIZE) {
    const batch = todo.slice(i, i + EMBED_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = await embed(batch.map((b) => b.cmd.slice(0, MAX_EMBED_CHARS)), "document");
      if (vectors.length !== batch.length) throw new Error(`expected ${batch.length} vectors, got ${vectors.length}`);
    } catch (e) {
      failed += batch.length;
      error ??= e instanceof Error ? e.message : String(e);
      // Nothing answered: the remaining batches would time out the same way.
      if (e instanceof LlmError && e.kind === "unreachable") break;
      continue;
    }
    const rows: Array<{ hash: string; id: number; vec: Float32Array }> = [];
    batch.forEach((b, j) => {
      try {
        rows.push({ hash: b.hash, id: b.id, vec: normalize(vectors[j]) });
      } catch (e) {
        failed++;
        error ??= e instanceof Error ? e.message : String(e);
      }
    });
    write(rows);
    embedded += rows.length;
  }

  return { model, embedded, skipped, failed, remaining: pending.length - embedded, ...(error ? { error } : {}) };
}
