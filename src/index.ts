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

const server = new Server(
  { name: "terminal-history-mcp", version: "0.2.2" },
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
      "Local index only; nothing is sent anywhere. If a query returns nothing you may need `reindex` first.",
    annotations: { title: "Search shell history", ...READ_ONLY },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "FTS5 query. Plain keywords are ANDed; append `*` for prefix match. E.g. `npm install`, `kubectl get po*`." },
        limit: { type: "number", description: "Maximum number of matching commands to return, newest first. Default 20.", default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" }, results: { type: "array", items: COMMAND_ROW } },
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
      const { query, limit } = z.object({ query: z.string(), limit: z.number().optional() }).parse(args);
      const rows = searchHistory(db, query, limit ?? 20);
      return { content: [{ type: "text", text: fmt(rows) }], structuredContent: { count: rows.length, results: rows } };
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
