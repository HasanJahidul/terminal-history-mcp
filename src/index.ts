#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDb } from "./db.js";
import { loadHistoryFiles, indexEntries } from "./indexer.js";
import { ingestExtendedLog } from "./extended-log.js";
import {
  searchHistory,
  recentInDir,
  failedCommands,
  commandChains,
  type SearchRow,
} from "./search.js";
import { readLlmConfig, embedTexts, chatComplete, ENV, type LlmConfig } from "./llm.js";
import { reindexEmbeddings, DEFAULT_REINDEX_LIMIT, EMBED_BATCH_SIZE } from "./embeddings.js";
import {
  searchByMode,
  askHistory,
  SEARCH_MODES,
  HYBRID_CANDIDATES,
  RRF_K,
  ASK_DEFAULT_K,
  NO_RELEVANT_ANSWER,
  type SemanticDeps,
  type RankedRow,
} from "./semantic-search.js";

const db = openDb();

function fmt(rows: SearchRow[]): string {
  if (!rows.length) return "(no results)";
  return rows.map((r) => {
    const when = r.ts ? new Date(r.ts).toISOString() : "?";
    const exit = r.exit_code == null ? "" : ` exit=${r.exit_code}`;
    const cwd = r.cwd ? ` cwd=${r.cwd}` : "";
    return `[${r.shell} ${when}${exit}${cwd}] ${r.cmd}`;
  }).join("\n");
}

function withIds(rows: SearchRow[]): string {
  if (!rows.length) return "(no results)";
  return rows.map((r) => `[id:${r.id}] ${fmt([r])}`).join("\n");
}

// Read per call so env changes in tests apply; throws the privacy-guardrail error for
// non-localhost endpoints without the opt-in.
function semanticDepsFrom(cfg: LlmConfig): SemanticDeps {
  return { model: cfg.embedModel, embed: (texts, purpose) => embedTexts(cfg, texts, purpose) };
}
function semanticDeps(): SemanticDeps {
  return semanticDepsFrom(readLlmConfig());
}

const server = new Server(
  { name: "terminal-history-mcp", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

// Search tools are read-only against the local SQLite index — no network,
// no shell execution, nothing leaves the machine. `reindex` writes to the
// index but is idempotent (hash-deduped).
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const COMMAND_ROW = {
  type: "object",
  properties: {
    cmd: { type: "string", description: "The command line as recorded (secrets already redacted at index time)." },
    ts: { type: ["number", "null"], description: "Epoch milliseconds when the command ran, or null if the shell did not record a timestamp." },
    shell: { type: "string", description: "`zsh`, `bash`, `fish`, or `ext` (entry enriched by the shell hook)." },
    cwd: { type: ["string", "null"], description: "Working directory the command ran in. Null for entries recorded before the hook was installed." },
    exit_code: { type: ["number", "null"], description: "Process exit code. Null when not captured." },
    duration_ms: { type: ["number", "null"], description: "Wall-clock duration in milliseconds, if the hook captured it." },
  },
} as const;

const RANKED_ROW = {
  type: "object",
  properties: {
    id: { type: "number", description: "Entry id; ask_history cites entries by this id." },
    ...COMMAND_ROW.properties,
    similarity: { type: "number", description: "Cosine similarity to the query (semantic/hybrid)." },
    rrf_score: { type: "number", description: `Reciprocal Rank Fusion score, sum of 1/(${RRF_K}+rank) (hybrid).` },
    keyword_rank: { type: ["number", "null"], description: "1-based rank in the keyword list, null if absent (hybrid)." },
    semantic_rank: { type: ["number", "null"], description: "1-based rank in the vector list, null if absent (hybrid)." },
  },
} as const;

const TOOLS = [
  {
    name: "reindex",
    description:
      "Re-parses the local shell history files (`~/.zsh_history`, `~/.bash_history`) and the hook's extended log into the SQLite index. " +
      "Idempotent — already-indexed commands are skipped by hash, so it is safe to call repeatedly. Run it after a burst of shell activity to make recent commands searchable. " +
      "Reads only local files; writes only to `~/.terminal-history-mcp/`. Takes no arguments. Returns counts of parsed / inserted / skipped entries.",
    annotations: { title: "Reindex shell history", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        parsed: { type: "number", description: "History-file lines parsed this run." },
        inserted: { type: "number", description: "New rows added from history files." },
        skipped: { type: "number", description: "Rows skipped because already indexed." },
        ext_applied: { type: "number", description: "Extended-log records merged into existing rows." },
        ext_inserted: { type: "number", description: "Extended-log records inserted as new rows." },
      },
    },
  },
  {
    name: "search_history",
    description:
      "Read-only. Full-text search (SQLite FTS5, stemmed, Unicode-aware) over all indexed shell commands. " +
      "Supports keyword and prefix queries — e.g. `docker build`, `git reb*`. Returns the most recent matches first, each with timestamp, shell, cwd, and exit code when available. " +
      "Default `keyword` mode is local index only; nothing is sent anywhere. `semantic` and `hybrid` modes embed only the query through the configured OpenAI-compatible endpoint (localhost Ollama by default) and need `reindex_embeddings` to have run. " +
      "If a query returns nothing you may need `reindex` first.",
    annotations: { title: "Search shell history", ...READ_ONLY },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "FTS5 query. Plain keywords are ANDed; append `*` for prefix match. E.g. `npm install`, `kubectl get po*`." },
        limit: { type: "number", description: "Maximum number of matching commands to return, newest first. Default 20.", default: 20 },
        mode: {
          type: "string",
          enum: [...SEARCH_MODES],
          default: "keyword",
          description:
            "`keyword` (default): FTS5 bm25, exactly the previous behaviour. " +
            "`semantic`: embedding similarity, finds paraphrases (\"free up docker disk space\" -> `docker system prune`); returns an error if embeddings are unavailable. " +
            `\`hybrid\`: fuses the top ${HYBRID_CANDIDATES} keyword and top ${HYBRID_CANDIDATES} semantic results with Reciprocal Rank Fusion (k=${RRF_K}), one row per distinct command; falls back to keyword results, and says so, if embeddings are unavailable.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "number" },
        results: { type: "array", items: RANKED_ROW },
        mode: { type: "string", enum: [...SEARCH_MODES], description: "Mode actually used. Omitted for keyword requests, whose output is unchanged." },
        requested_mode: { type: "string", description: "Present when hybrid fell back to keyword." },
        fallback_reason: { type: "string", description: "Why hybrid fell back to keyword (endpoint unreachable, empty index, guardrail)." },
        keyword_error: { type: "string", description: "Hybrid only: the keyword query failed to parse, so results come from the vector list alone." },
      },
    },
  },
  {
    name: "recent_in_dir",
    description:
      "Read-only. Lists the most recent commands that were run with a given working directory — answers \"what was I doing in this project?\". " +
      "Requires the shell hook to have been installed (legacy entries have no cwd and won't appear). Returns newest first with timestamps and exit codes. Local index only.",
    annotations: { title: "Recent commands in directory", ...READ_ONLY },
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute working-directory path to filter by, e.g. `/Users/me/code/myapp`. Matched exactly." },
        limit: { type: "number", description: "Maximum number of commands to return, newest first. Default 20.", default: 20 },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" }, results: { type: "array", items: COMMAND_ROW } },
    },
  },
  {
    name: "failed_commands",
    description:
      "Read-only. Lists recent commands that exited non-zero — a quick \"what just broke?\" feed. " +
      "Optionally restrict to commands after a given epoch-millisecond timestamp. Requires the shell hook for exit-code capture (legacy entries have no exit code). Newest first. Local index only.",
    annotations: { title: "Recent failed commands", ...READ_ONLY },
    inputSchema: {
      type: "object",
      properties: {
        since_ts_ms: { type: ["number", "null"], description: "Only return commands with a timestamp at or after this epoch-millisecond value. Null/omitted = no lower bound." },
        limit: { type: "number", description: "Maximum number of commands to return, newest first. Default 20.", default: 20 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" }, results: { type: "array", items: COMMAND_ROW } },
    },
  },
  {
    name: "command_chains",
    description:
      "Read-only. For each command matching `query`, returns the commands run within a time window around it (default ±5 min) — surfacing multi-step sequences like `cd → npm run build → deploy`. " +
      "Useful for reconstructing \"how did I do X last time?\". Returns up to `limit` chains, each a time-ordered list of command rows. Local index only.",
    annotations: { title: "Command chains around matches", ...READ_ONLY },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "FTS5 query identifying the anchor command(s). Same syntax as `search_history`." },
        window_ms: { type: "number", description: "Half-width of the time window around each match, in milliseconds. Default 300000 (±5 min).", default: 300000 },
        limit: { type: "number", description: "Maximum number of chains (one per anchor match) to return. Default 5.", default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "number" },
        chains: { type: "array", items: { type: "array", items: COMMAND_ROW }, description: "Each chain is a time-ordered list of command rows around one anchor match." },
      },
    },
  },
  {
    name: "reindex_embeddings",
    description:
      "Builds the vector index behind `search_history` semantic/hybrid modes and `ask_history`. " +
      `Embeds distinct indexed command texts (identical commands share one vector) that have no vector yet for the configured model, newest first, in batches of ${EMBED_BATCH_SIZE}, ` +
      `via the OpenAI-compatible endpoint in ${ENV.baseUrl} (default Ollama at http://localhost:11434/v1, model nomic-embed-text from ${ENV.embedModel}). ` +
      `Non-localhost endpoints are refused unless ${ENV.allowRemote}=1. Sends only already-redacted text read from the local index. ` +
      "Changing the embedding model re-embeds everything for the new model. Run `reindex` first, then call until `remaining` is 0. " +
      "Returns embedded / skipped / failed / remaining counts.",
    annotations: { title: "Build semantic search index", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `Maximum number of distinct command texts to embed in this call. Default ${DEFAULT_REINDEX_LIMIT}.`, default: DEFAULT_REINDEX_LIMIT },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Embedding model the vectors were built with." },
        embedded: { type: "number", description: "Vectors written this call." },
        skipped: { type: "number", description: "Distinct texts already embedded for this model (or blank)." },
        failed: { type: "number", description: "Texts the endpoint rejected or failed on this call." },
        remaining: { type: "number", description: "Distinct texts still without a vector for this model." },
        error: { type: "string", description: "First error seen, if any." },
      },
    },
  },
  {
    name: "ask_history",
    description:
      "Read-only. Answers a natural-language question about your shell history, with citations (retrieval-augmented generation). " +
      `Retrieves the top \`k\` entries with hybrid search, then, if ${ENV.chatModel} is set, asks that chat model to answer only from those entries and cite them as [id:N]. ` +
      "Retrieved commands are passed as delimited untrusted data, never as instructions. " +
      `Replies exactly "${NO_RELEVANT_ANSWER}" when nothing retrieved is relevant. Without a chat model it returns the retrieved context only. ` +
      "Cited ids are checked against the retrieved set; any others are listed in `invalid_citation_ids`.",
    annotations: { title: "Ask your shell history", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural-language question, e.g. \"how did I free up docker disk space?\"" },
        k: { type: "number", description: `Number of entries to retrieve as context. Default ${ASK_DEFAULT_K}.`, default: ASK_DEFAULT_K },
      },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: ["string", "null"], description: "Model answer with [id:N] citations; null when no chat model is configured." },
        cited_ids: { type: "array", items: { type: "number" }, description: "Cited ids that exist in the retrieved set." },
        cited_entries: { type: "array", items: RANKED_ROW },
        invalid_citation_ids: { type: "array", items: { type: "number" }, description: "Ids the model cited that were not retrieved." },
        retrieved: { type: "array", items: RANKED_ROW, description: "Context given to the model." },
        retrieval_mode: { type: "string", enum: [...SEARCH_MODES], description: "`hybrid`, or `keyword` if it fell back." },
        fallback_reason: { type: "string" },
        keyword_error: { type: "string" },
        note: { type: "string" },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as any;

  try {
    if (name === "reindex") {
      const entries = loadHistoryFiles();
      const r = indexEntries(db, entries);
      const ext = ingestExtendedLog(db);
      const summary = { parsed: entries.length, inserted: r.inserted, skipped: r.skipped, ext_applied: ext.applied, ext_inserted: ext.inserted };
      return {
        content: [{ type: "text", text: `parsed=${summary.parsed} inserted=${summary.inserted} skipped=${summary.skipped} ext_applied=${summary.ext_applied} ext_inserted=${summary.ext_inserted}` }],
        structuredContent: summary,
      };
    }
    if (name === "search_history") {
      const { query, limit, mode } = z.object({
        query: z.string(), limit: z.number().optional(), mode: z.enum(SEARCH_MODES).optional(),
      }).parse(args);
      if (mode === undefined || mode === "keyword") {
        const rows = searchHistory(db, query, limit ?? 20);
        return { content: [{ type: "text", text: fmt(rows) }], structuredContent: { count: rows.length, results: rows } };
      }
      const r = await searchByMode(db, query, mode, limit ?? 20, semanticDeps);
      const fellBack = r.mode !== mode;
      const notes = [
        fellBack ? `[note: ${mode} search fell back to keyword: ${r.fallback_reason}]` : null,
        r.keyword_error ? `[note: keyword half skipped: ${r.keyword_error}]` : null,
      ].filter((n): n is string => n !== null);
      return {
        content: [{ type: "text", text: [...notes, fmt(r.results)].join("\n") }],
        structuredContent: {
          count: r.results.length,
          results: r.results,
          mode: r.mode,
          ...(fellBack ? { requested_mode: mode, fallback_reason: r.fallback_reason } : {}),
          ...(r.keyword_error ? { keyword_error: r.keyword_error } : {}),
        },
      };
    }
    if (name === "reindex_embeddings") {
      const { limit } = z.object({ limit: z.number().int().positive().optional() }).parse(args);
      const cfg = readLlmConfig();
      const r = await reindexEmbeddings(db, semanticDepsFrom(cfg).embed, cfg.embedModel, limit ?? DEFAULT_REINDEX_LIMIT);
      const text = `model=${r.model} embedded=${r.embedded} skipped=${r.skipped} failed=${r.failed} remaining=${r.remaining}` +
        (r.error ? `\nerror: ${r.error}` : "");
      return {
        content: [{ type: "text", text }],
        structuredContent: r,
        ...(r.error && r.embedded === 0 ? { isError: true } : {}),
      };
    }
    if (name === "ask_history") {
      const { question, k } = z.object({ question: z.string().min(1), k: z.number().int().positive().optional() }).parse(args);
      const cfg = readLlmConfig();
      const r = await askHistory(db, question, k ?? ASK_DEFAULT_K, {
        getSemantic: () => semanticDepsFrom(cfg),
        chat: cfg.chatModel ? (messages) => chatComplete(cfg, messages) : null,
      });
      const sources: RankedRow[] = r.answer === null ? r.retrieved : r.cited_entries;
      const head = r.answer ?? `(${r.note})`;
      const notes = [r.fallback_reason ? `[note: retrieval fell back to keyword: ${r.fallback_reason}]` : null]
        .filter((n): n is string => n !== null);
      const text = [...notes, head, "", r.answer === null ? "Retrieved context:" : "Sources:", withIds(sources)].join("\n");
      return { content: [{ type: "text", text }], structuredContent: r };
    }
    if (name === "recent_in_dir") {
      const { cwd, limit } = z.object({ cwd: z.string(), limit: z.number().optional() }).parse(args);
      const rows = recentInDir(db, cwd, limit ?? 20);
      return { content: [{ type: "text", text: fmt(rows) }], structuredContent: { count: rows.length, results: rows } };
    }
    if (name === "failed_commands") {
      const { since_ts_ms, limit } = z.object({
        since_ts_ms: z.number().nullable().optional(),
        limit: z.number().optional(),
      }).parse(args);
      const rows = failedCommands(db, since_ts_ms ?? null, limit ?? 20);
      return { content: [{ type: "text", text: fmt(rows) }], structuredContent: { count: rows.length, results: rows } };
    }
    if (name === "command_chains") {
      const { query, window_ms, limit } = z.object({
        query: z.string(), window_ms: z.number().optional(), limit: z.number().optional(),
      }).parse(args);
      const chains = commandChains(db, query, window_ms ?? 300000, limit ?? 5);
      const text = chains.map((c, i) => `--- chain ${i + 1} ---\n${fmt(c)}`).join("\n\n");
      return { content: [{ type: "text", text: text || "(no chains)" }], structuredContent: { count: chains.length, chains } };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (e: any) {
    return { content: [{ type: "text", text: `error: ${e?.message ?? String(e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("server failed:", err);
  process.exit(1);
});
