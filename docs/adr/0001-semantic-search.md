# ADR 0001: Semantic and hybrid search over shell history

- Status: Accepted
- Date: 2026-11-08

## Context

`search_history` is SQLite FTS5 (bm25, porter stemming). It finds commands by their words, so a question like "how did I free up docker disk space" does not reliably reach `docker system prune -af`. Agents ask questions in that form, so we want retrieval by meaning, plus an optional answer step (RAG) on top.

Constraints:

- Shell history is sensitive. Secrets are redacted at insert time, but paths, hostnames and project names remain. The default must stay on the machine.
- No new runtime or dev dependencies (today: MCP SDK, better-sqlite3, zod). One SQLite file. Node 18+.
- Existing keyword behaviour must not change.
- Scale is one person's history: roughly 10^3 to 10^5 distinct commands.

## Options

### Vector search: sqlite-vec vs brute force

- **sqlite-vec** (`vec0` virtual table, KNN in C, same DB file). It's the natural next step, but it's a native loadable extension: a new dependency with per-platform binaries, extension loading through better-sqlite3, and more surface in the CI matrix (macOS/Linux × Node 18/20/22).
- **ANN index** (HNSW via hnswlib-node, usearch). Approximate, native, and persisted outside the DB file. It only pays off at scales we don't have.
- **Brute force in TypeScript**. Exact results, zero dependencies, one short function, and vectors in the same DB and transactions as the rows they describe. The cost is O(N·d) per query.

### Embeddings: local vs cloud

- **Local** (Ollama, `nomic-embed-text`, 768 dims). Private, free, offline. Needs Ollama installed and the model pulled (~274 MB).
- **Cloud** (e.g. OpenAI embeddings). No setup and probably stronger models. It also ships shell history off the machine, which conflicts with the product's main promise. Not measured here.

### Fusion: Reciprocal Rank Fusion vs weighted scores

- **Weighted score**, `α·norm(bm25) + (1−α)·cos`. bm25 is unbounded and query-dependent, so it needs per-query normalisation, and α needs labelled data to tune.
- **RRF**, `Σ 1/(k + rank)` with k = 60 (Cormack et al., 2009). Uses ranks only, so there is nothing to calibrate, and k = 60 is the standard default.

## Decision

- **One client for the OpenAI-compatible API** (`/embeddings`, `/chat/completions`) on native fetch with timeouts. Ollama, LM Studio, llama.cpp, vLLM and OpenAI all work. The default is `http://localhost:11434/v1`.
- **Privacy guardrail.** Any non-loopback base URL is refused unless `TERMINAL_HISTORY_ALLOW_REMOTE_LLM=1`. Only text read from the DB (already redacted) is embedded, and the query/question is passed through the same redactor before sending.
- **Storage.** One new table, `command_embeddings(content_hash, model, dims, entry_id, vector)`, with primary key `(content_hash, model)`:
  - Identical command text is embedded once.
  - Changing the model re-embeds.
  - Vectors are L2-normalised Float32 BLOBs, so a dot product is the cosine.
  - Existing tables are untouched.
- **Brute-force exact search** for now. The scaling ceiling and the sqlite-vec upgrade path are noted at the call site.
- **`search_history` gets `mode`** (`keyword` default, `semantic`, `hybrid`). Hybrid takes the top 50 from FTS5 and the top 50 from vectors and fuses them with RRF (k = 60). It fuses on command text, not entry id, because keyword search returns every occurrence of a command while the index holds one vector per distinct text.
- **Graceful degradation.**
  - Hybrid falls back to keyword results and states `fallback_reason` when embeddings are unavailable: endpoint unreachable, empty index, or guardrail refusal.
  - Semantic mode returns an explicit error instead.
  - When the keyword parser rejects a query, hybrid continues on the vector list alone (`keyword_error`).
- **`ask_history`** retrieves the hybrid top-k (default 8) and passes the entries to the chat model as untrusted data:
  - The data sits between per-request random-nonce delimiters, with one line per entry and newlines escaped so a command cannot forge an entry.
  - The model answers only from those entries, cites them as `[id:N]`, or replies exactly "No relevant history found.".
  - Citations are validated against the retrieved ids.
  - The model is not called when nothing was retrieved.
  - Temperature is 0.
- **nomic-embed-text task prefixes** (`search_query:` / `search_document:`) are applied, as the model card requires. Our eval could not measure their effect (see below).

## Measured results

Measured with `npm run eval` on an Apple M4 (10 cores, 16 GB), Node 24.15.0, Ollama 0.40.13, `nomic-embed-text`. Embedding the 200 fixture commands took 1970 ms.

**The eval set is synthetic.** 200 author-written commands across 17 tool areas, with deliberate distractors, plus 25 author-written queries (19 "paraphrase", 6 "keyword-friendly"). The queries were written before the first run and not changed afterwards. It is small and not real user data.

| mode | all (25) recall@5 | all MRR@10 | paraphrase (19) recall@5 | paraphrase MRR@10 | keyword-friendly (6) recall@5 | keyword-friendly MRR@10 |
|------|---:|---:|---:|---:|---:|---:|
| keyword  | 0.680 | 0.516 | 0.579 | 0.390 | 1.000 | 0.917 |
| semantic | 0.680 | 0.587 | 0.579 | 0.483 | 1.000 | 0.917 |
| hybrid   | 0.720 | 0.583 | 0.632 | 0.478 | 1.000 | 0.917 |

recall@5 is the share of a query's relevant ids in the top 5, averaged. MRR@10 is the mean of 1/rank of the first relevant id within the top 10, or 0 if absent.

What the per-query ranks show:

- Semantic ranks paraphrases higher when the meaning is in the words. Examples: "free up docker disk space" moves from rank 9 (keyword) to 2; "go back to the previous helm release" and "add more workers to handle the load" go from 3 to 1; "create an isolated python environment" goes from 8 to 4.
- **All three modes miss** `git bisect`, `git reflog`, `caffeinate -d` and `du -sh * | sort -h`. When the meaning lives in a tool name, embedding the bare command text gives the model too little to work with.
- The keyword builder ORs prefix-matched tokens. Several "paraphrase" queries share a token with their command (`redis`, `audio`, `log`, `backup`), which is why keyword search reaches 0.579 recall@5 on them. The label is looser than intended.
- Hybrid can bury a keyword hit that the vector list disagrees with. "Share the files in this folder over a quick local web server" sits at keyword rank 4 but falls out of hybrid's top 10.
- One query changes recall@5 by 0.04. The differences between modes on this set are within that noise, so this eval does not show that hybrid beats semantic.

Task-prefix A/B on the same set:

| | semantic recall@5 | semantic MRR@10 | hybrid recall@5 | hybrid MRR@10 |
|---|---:|---:|---:|---:|
| with prefixes    | 0.680 | 0.587 | 0.720 | 0.583 |
| without prefixes | 0.660 | 0.637 | 0.740 | 0.586 |

The changes go in both directions and are within noise. We kept the documented usage.

Brute-force latency: random unit vectors, d = 768, top-50, median / p95 of 20 queries after 3 warm-up runs, file-backed SQLite in WAL mode, warm OS cache:

| N | `vectorSearch` (SQLite read + scan) | in-memory Float32Array scan | DB size |
|---:|---|---|---:|
| 10,000  | 23.0 ms / 26.0 ms   | 6.1 ms / 10.3 ms  | 41.5 MB  |
| 100,000 | 237.4 ms / 283.9 ms | 61.4 ms / 73.6 ms | 414.8 MB |

Loading the vectors into memory once took 139 ms at 10k and 5399 ms at 100k. sqlite-vec was not benchmarked.

## Consequences

- Keyword search is unchanged and remains the default. Semantic features are opt-in and degrade to keyword instead of failing.
- With no new dependencies, the CI matrix and install stay as they were.
- Most of the time at 100k vectors is reading BLOBs out of SQLite, not the arithmetic (237 ms vs 61 ms). The first upgrade is to keep the vectors in memory; at 100k × 768 floats it costs 307 MB of RAM and the measured 5.4 s one-time load. The next step is sqlite-vec.
- The quality limit is the document text, not the index. The next experiment is document expansion: embed each command together with a short description, for example from tldr pages. That should be measured on a larger, ideally real, opt-in labelled set before adopting it.
- `reindex_embeddings` must be called after `reindex`; there is no automatic sync. Vectors from previous models are kept, so switching back is free but uses disk. Commands are cut to 2000 characters before embedding.
- `ask_history` answer quality was not evaluated quantitatively. It was only checked against qwen2.5:7b: one relevant question returned an answer citing a retrieved id, and one unrelated question returned exactly "No relevant history found.". The first call on a cold 7B model took more than 120 s, so the chat timeout is 300 s.
- Pre-existing issue, out of scope here: the keyword query builder raises FTS5 syntax errors on `NOT` / `OR` / `AND` and on hyphenated tokens such as `port-forward`. Keyword mode still has it; hybrid tolerates it.
