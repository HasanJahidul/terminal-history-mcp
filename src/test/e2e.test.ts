// End-to-end over JSON-RPC stdio against the built server. Hermetic: the server runs with a
// temporary HOME (so ~/.terminal-history-mcp is never touched) and talks to a fake
// OpenAI-compatible endpoint on 127.0.0.1, so no network or Ollama is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, type ChatMessage } from "../llm.js";
import { NO_RELEVANT_ANSWER } from "../semantic-search.js";
import { fakeEmbedOne, fakeAnswer } from "./helpers.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const HISTORY = [
  "docker system prune -af",
  "docker ps -a",
  "git rebase -i HEAD~3",
  "kubectl get pods -n prod",
  `git clone https://${TOKEN}@github.com/me/private-repo`,
  "npm install --save-dev typescript",
  "ls -la",
  "ls -la",
];

type FakeLlm = { url: string; embedInputs: string[]; chatCalls: number; close: () => Promise<void> };

function startFakeLlm(): Promise<FakeLlm> {
  const state = { embedInputs: [] as string[], chatCalls: 0 };
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        const input: string[] = json.input;
        state.embedInputs.push(...input);
        res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: fakeEmbedOne(t) })) }));
      } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
        state.chatCalls++;
        const content = fakeAnswer(json.messages as ChatMessage[]);
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        get embedInputs() { return state.embedInputs; },
        get chatCalls() { return state.chatCalls; },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// A port that was just bound and released: connections to it are refused.
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: any; isError?: boolean };

function startServer(home: string, llmEnv: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HISTFILE: join(home, ".zsh_history") };
  for (const key of Object.values(ENV)) delete env[key];
  Object.assign(env, llmEnv);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let nextId = 1;
  const waiting = new Map<number, (msg: any) => void>();
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    list: (): Promise<{ tools: any[] }> => rpc("tools/list", {}),
    call: (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => rpc("tools/call", { name, arguments: args }),
    close: () => new Promise<void>((r) => { child.once("exit", () => r()); child.kill(); }),
  };
}

test("e2e: MCP server over JSON-RPC stdio", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "th-e2e-"));
  writeFileSync(join(home, ".zsh_history"), HISTORY.map((c, i) => `: ${1_700_000_000 + i * 60}:0;${c}`).join("\n") + "\n");
  const llm = await startFakeLlm();
  const llmEnv = { [ENV.baseUrl]: llm.url, [ENV.embedModel]: "fake-embed", [ENV.chatModel]: "fake-chat" };
  let server = startServer(home, llmEnv);

  try {
    await server.init();

    await t.test("tools/list shows the new tools with their schemas", async () => {
      const { tools } = await server.list();
      const byName = new Map(tools.map((x) => [x.name, x]));
      for (const name of ["reindex", "search_history", "recent_in_dir", "failed_commands", "command_chains", "reindex_embeddings", "ask_history"]) {
        assert.ok(byName.has(name), name);
      }
      const search = byName.get("search_history");
      assert.deepEqual(search.inputSchema.properties.mode.enum, ["keyword", "semantic", "hybrid"]);
      assert.equal(search.inputSchema.properties.mode.default, "keyword");
      assert.deepEqual(search.inputSchema.required, ["query"]);

      const reindex = byName.get("reindex_embeddings");
      assert.equal(reindex.inputSchema.properties.limit.default, 2000);
      assert.equal(reindex.annotations.readOnlyHint, false);

      const ask = byName.get("ask_history");
      assert.deepEqual(ask.inputSchema.required, ["question"]);
      assert.equal(ask.inputSchema.properties.k.default, 8);
      assert.equal(ask.annotations.readOnlyHint, true);
      assert.ok(ask.outputSchema.properties.cited_ids);
    });

    await t.test("reindex, then reindex_embeddings sends only scrubbed text", async () => {
      const r = await server.call("reindex");
      assert.equal(r.structuredContent.inserted, HISTORY.length);
      const e = await server.call("reindex_embeddings");
      assert.equal(e.isError, undefined);
      assert.deepEqual(e.structuredContent, { model: "fake-embed", embedded: new Set(HISTORY).size, skipped: 0, failed: 0, remaining: 0 });
      const sent = llm.embedInputs.join("\n");
      assert.doesNotMatch(sent, /abcdefghijklmnop/);
      assert.match(sent, /ghp_\*\*\*/);
    });

    await t.test("keyword mode output is identical with and without mode", async () => {
      const plain = await server.call("search_history", { query: "docker" });
      const explicit = await server.call("search_history", { query: "docker", mode: "keyword" });
      assert.deepEqual(explicit, plain);
      assert.deepEqual(Object.keys(plain.structuredContent), ["count", "results"]);
      assert.ok(plain.structuredContent.count > 0);
    });

    await t.test("hybrid search returns fused structured results with ids", async () => {
      const r = await server.call("search_history", { query: "how did I free up docker disk space", mode: "hybrid", limit: 3 });
      assert.equal(r.isError, undefined);
      assert.equal(r.structuredContent.mode, "hybrid");
      assert.equal(r.structuredContent.fallback_reason, undefined);
      const [top] = r.structuredContent.results;
      assert.equal(top.cmd, "docker system prune -af");
      assert.equal(typeof top.id, "number");
      assert.equal(typeof top.rrf_score, "number");
    });

    await t.test("semantic search ranks the paraphrase first", async () => {
      const r = await server.call("search_history", { query: "how did I free up docker disk space", mode: "semantic", limit: 3 });
      assert.equal(r.structuredContent.mode, "semantic");
      assert.equal(r.structuredContent.results[0].cmd, "docker system prune -af");
    });

    await t.test("ask_history answers with cited entry ids", async () => {
      const r = await server.call("ask_history", { question: "how did I free up docker disk space?" });
      assert.equal(r.isError, undefined);
      const s = r.structuredContent;
      assert.match(s.answer, /\[id:\d+\]/);
      assert.ok(s.cited_ids.length > 0);
      const retrieved = new Set(s.retrieved.map((x: { id: number }) => x.id));
      for (const id of s.cited_ids) assert.ok(retrieved.has(id), `cited id ${id} was retrieved`);
      assert.equal(s.cited_entries[0].cmd, "docker system prune -af");
      assert.equal(s.retrieval_mode, "hybrid");
    });

    await t.test("ask_history says exactly 'No relevant history found.' for an unrelated question", async () => {
      const r = await server.call("ask_history", { question: "what is the capital of France?" });
      assert.equal(r.structuredContent.answer, NO_RELEVANT_ANSWER);
      assert.deepEqual(r.structuredContent.cited_ids, []);
    });

    await server.close();
    const port = await closedPort();
    server = startServer(home, { ...llmEnv, [ENV.baseUrl]: `http://127.0.0.1:${port}/v1` });
    await server.init();

    await t.test("unreachable endpoint: hybrid falls back to keyword and says so", async () => {
      const keyword = await server.call("search_history", { query: "docker", limit: 5 });
      const r = await server.call("search_history", { query: "docker", mode: "hybrid", limit: 5 });
      assert.equal(r.isError, undefined);
      assert.equal(r.structuredContent.mode, "keyword");
      assert.equal(r.structuredContent.requested_mode, "hybrid");
      assert.match(r.structuredContent.fallback_reason, /cannot reach/);
      assert.deepEqual(r.structuredContent.results, keyword.structuredContent.results);
      assert.match(r.content[0].text, /fell back to keyword/);
    });

    await t.test("unreachable endpoint: semantic returns a clear error, server keeps running", async () => {
      const r = await server.call("search_history", { query: "docker", mode: "semantic" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Semantic search unavailable: cannot reach/);
      const again = await server.call("search_history", { query: "docker" });
      assert.ok(again.structuredContent.count > 0);
    });

    await server.close();
    server = startServer(home, { ...llmEnv, [ENV.baseUrl]: "https://api.example.com/v1" });
    await server.init();

    await t.test("non-localhost endpoint is refused without the opt-in", async () => {
      const e = await server.call("reindex_embeddings");
      assert.equal(e.isError, true);
      assert.match(e.content[0].text, /Refusing to send shell history/);
      const s = await server.call("search_history", { query: "docker", mode: "hybrid" });
      assert.equal(s.structuredContent.mode, "keyword");
      assert.match(s.structuredContent.fallback_reason, /Refusing/);
    });
  } finally {
    await server.close();
    await llm.close();
    rmSync(home, { recursive: true, force: true });
  }
});
