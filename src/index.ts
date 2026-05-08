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
  { name: "terminal-history-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "reindex",
    description: "Re-parse ~/.zsh_history and ~/.bash_history into the local index. Run after new shell activity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_history",
    description: "Full-text search across indexed shell history. Returns matching commands with timestamp/cwd/exit code.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search. Supports prefix match." },
        limit: { type: "number", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "recent_in_dir",
    description: "List recent commands run in a specific working directory (requires cwd capture, may be empty for legacy entries).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        limit: { type: "number", default: 20 },
      },
      required: ["cwd"],
    },
  },
  {
    name: "failed_commands",
    description: "Recent commands with non-zero exit code. Useful for debugging recent shell errors.",
    inputSchema: {
      type: "object",
      properties: {
        since_ts_ms: { type: ["number", "null"] },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "command_chains",
    description: "For each match of query, return commands run within ±5 min — reveals multi-step sequences (cd → build → deploy).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        window_ms: { type: "number", default: 300000 },
        limit: { type: "number", default: 5 },
      },
      required: ["query"],
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
      return { content: [{ type: "text", text: `parsed=${entries.length} inserted=${r.inserted} skipped=${r.skipped} ext_applied=${ext.applied} ext_inserted=${ext.inserted}` }] };
    }
    if (name === "search_history") {
      const { query, limit } = z.object({ query: z.string(), limit: z.number().optional() }).parse(args);
      return { content: [{ type: "text", text: fmt(searchHistory(db, query, limit ?? 20)) }] };
    }
    if (name === "recent_in_dir") {
      const { cwd, limit } = z.object({ cwd: z.string(), limit: z.number().optional() }).parse(args);
      return { content: [{ type: "text", text: fmt(recentInDir(db, cwd, limit ?? 20)) }] };
    }
    if (name === "failed_commands") {
      const { since_ts_ms, limit } = z.object({
        since_ts_ms: z.number().nullable().optional(),
        limit: z.number().optional(),
      }).parse(args);
      return { content: [{ type: "text", text: fmt(failedCommands(db, since_ts_ms ?? null, limit ?? 20)) }] };
    }
    if (name === "command_chains") {
      const { query, window_ms, limit } = z.object({
        query: z.string(), window_ms: z.number().optional(), limit: z.number().optional(),
      }).parse(args);
      const chains = commandChains(db, query, window_ms ?? 300000, limit ?? 5);
      const text = chains.map((c, i) => `--- chain ${i + 1} ---\n${fmt(c)}`).join("\n\n");
      return { content: [{ type: "text", text: text || "(no chains)" }] };
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
