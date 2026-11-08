#!/usr/bin/env node
// npm run eval
//
// 1. Retrieval quality: recall@5 and MRR@10 for keyword / semantic / hybrid over a committed,
//    SYNTHETIC fixture (eval/fixtures/history.json, 200 commands) and golden set
//    (eval/fixtures/golden.json, 25 queries). Uses the configured embedding endpoint (default
//    Ollama at http://localhost:11434/v1, nomic-embed-text). Skipped, with a message, if no
//    endpoint answers.
// 2. Brute-force vector search latency at 10k and 100k random unit vectors. Needs no endpoint.
//
// Runs the same built code as the server (dist/). Uses throwaway SQLite files in the OS temp
// dir; never touches ~/.terminal-history-mcp. Prints measured numbers only.
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, cpus, platform, arch, totalmem } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readLlmConfig, embedTexts } from "../dist/llm.js";
import {
  ensureEmbeddingsSchema, reindexEmbeddings, vectorSearch, normalize, encodeVector, decodeVector,
} from "../dist/embeddings.js";
import { searchByMode, SEARCH_MODES } from "../dist/semantic-search.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/history.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(here, "fixtures/golden.json"), "utf8"));

const RECALL_AT = 5;
const MRR_AT = 10;
const LATENCY_SIZES = [10_000, 100_000];
const LATENCY_K = 50;
const WARMUP = 3;
const RUNS = 20;
const DEFAULT_BENCH_DIMS = 768; // nomic-embed-text; used when no endpoint is reachable
const BASE_TS = 1_767_225_600_000; // 2026-01-01T00:00:00Z

// Same commands/FTS schema as src/db.ts (and the unit tests), plus the embeddings table.
function createSchema(db) {
  db.exec(`
    CREATE TABLE commands (id INTEGER PRIMARY KEY AUTOINCREMENT, cmd TEXT NOT NULL, ts INTEGER, shell TEXT, cwd TEXT, exit_code INTEGER, duration_ms INTEGER, hash TEXT UNIQUE);
    CREATE VIRTUAL TABLE commands_fts USING fts5(cmd, cwd, content='commands', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER commands_ai AFTER INSERT ON commands BEGIN
      INSERT INTO commands_fts(rowid, cmd, cwd) VALUES (new.id, new.cmd, COALESCE(new.cwd,''));
    END;
  `);
  ensureEmbeddingsSchema(db);
}

function tempDb(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "eval.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- retrieval quality

async function quality(cfg) {
  const deps = () => ({ model: cfg.embedModel, embed: (t, p) => embedTexts(cfg, t, p) });
  const { db, cleanup } = tempDb("th-eval-");
  try {
    createSchema(db);
    const ins = db.prepare(
      `INSERT INTO commands (id, cmd, ts, shell, cwd, exit_code, duration_ms, hash) VALUES (?, ?, ?, 'zsh', ?, 0, NULL, ?)`,
    );
    db.transaction(() => { for (const f of fixture) ins.run(f.id, f.cmd, BASE_TS + f.id * 60_000, f.cwd, `fx${f.id}`); })();
    const ids = new Set(fixture.map((f) => f.id));
    if (new Set(fixture.map((f) => f.cmd)).size !== fixture.length) throw new Error("fixture commands must be distinct");
    for (const g of golden) for (const id of g.relevant) if (!ids.has(id)) throw new Error(`golden id ${id} not in fixture`);

    const t0 = performance.now();
    const r = await reindexEmbeddings(db, deps().embed, cfg.embedModel, fixture.length);
    const indexMs = performance.now() - t0;
    if (r.embedded !== fixture.length) throw new Error(`embedded ${r.embedded}/${fixture.length}: ${r.error ?? "unknown error"}`);
    const dims = db.prepare(`SELECT dims FROM command_embeddings LIMIT 1`).get().dims;

    const rows = [];
    for (const g of golden) {
      const per = {};
      for (const mode of SEARCH_MODES) {
        let got = [];
        let note;
        try {
          const res = await searchByMode(db, g.query, mode, MRR_AT, deps);
          if (res.mode !== mode) note = `fell back to ${res.mode}: ${res.fallback_reason}`;
          else if (res.keyword_error) note = `keyword half skipped: ${res.keyword_error}`;
          got = res.results.map((x) => x.id);
        } catch (e) {
          note = `error: ${e.message}`;
        }
        const top = got.slice(0, RECALL_AT);
        const recall = g.relevant.filter((id) => top.includes(id)).length / g.relevant.length;
        const firstRank = got.findIndex((id) => g.relevant.includes(id)) + 1; // 0 = not in top MRR_AT
        per[mode] = { recall, rr: firstRank > 0 ? 1 / firstRank : 0, firstRank, note };
      }
      rows.push({ g, per });
    }
    return { indexMs, dims, rows };
  } finally {
    cleanup();
  }
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function printQuality(cfg, q) {
  console.log(`\nRetrieval quality  (model ${cfg.embedModel}, ${q.dims} dims, ${cfg.baseUrl})`);
  console.log(`Indexed ${fixture.length} commands in ${q.indexMs.toFixed(0)} ms.`);
  console.log(`recall@${RECALL_AT} = share of a query's relevant ids in the top ${RECALL_AT}, averaged over queries.`);
  console.log(`MRR@${MRR_AT}    = mean of 1/rank of the first relevant id within the top ${MRR_AT} (0 if absent).\n`);
  const groups = [
    ["all", q.rows],
    ["paraphrase", q.rows.filter((r) => r.g.kind === "paraphrase")],
    ["keyword-friendly", q.rows.filter((r) => r.g.kind === "keyword")],
  ];
  const head = ["mode".padEnd(9), ...groups.map(([name, rs]) => `${name} (${rs.length})`.padEnd(24))].join(" ");
  console.log(head);
  console.log(["".padEnd(9), ...groups.map(() => `recall@${RECALL_AT}  MRR@${MRR_AT}`.padEnd(24))].join(" "));
  for (const mode of SEARCH_MODES) {
    const cells = groups.map(([, rs]) => {
      const rec = mean(rs.map((r) => r.per[mode].recall)).toFixed(3);
      const mrr = mean(rs.map((r) => r.per[mode].rr)).toFixed(3);
      return `${rec.padEnd(9)} ${mrr}`.padEnd(24);
    });
    console.log([mode.padEnd(9), ...cells].join(" "));
  }

  console.log(`\nRank of the first relevant id per query ("-" = not in top ${MRR_AT}):`);
  console.log(`${"kw".padStart(3)} ${"sem".padStart(4)} ${"hyb".padStart(4)}  kind        query`);
  for (const { g, per } of q.rows) {
    const cell = (m, w) => String(per[m].firstRank || "-").padStart(w);
    console.log(`${cell("keyword", 3)} ${cell("semantic", 4)} ${cell("hybrid", 4)}  ${g.kind.padEnd(10)}  ${g.query}`);
  }
  const notes = q.rows.flatMap(({ g, per }) =>
    SEARCH_MODES.filter((m) => per[m].note).map((m) => `  [${m}] "${g.query}": ${per[m].note}`));
  if (notes.length) {
    console.log(`\nNotes (${notes.length}):`);
    for (const n of notes) console.log(n);
  }
}

// ---------------------------------------------------------------- latency

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(rand, d) {
  const v = new Array(d);
  for (let i = 0; i < d; i++) v[i] = rand() * 2 - 1;
  return normalize(v);
}

// The same scan and top-k insertion as vectorSearch, over vectors already in one Float32Array.
function scanMatrix(matrix, n, d, q, k) {
  const top = [];
  for (let r = 0; r < n; r++) {
    const off = r * d;
    let s = 0;
    for (let i = 0; i < d; i++) s += q[i] * matrix[off + i];
    if (top.length === k && s <= top[k - 1].similarity) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].similarity < s) pos--;
    top.splice(pos, 0, { entry_id: r, similarity: s });
    if (top.length > k) top.pop();
  }
  return top;
}

function timeRuns(queries, fn) {
  for (let i = 0; i < WARMUP; i++) fn(queries[i]);
  const ms = [];
  for (let i = WARMUP; i < WARMUP + RUNS; i++) {
    const t = performance.now();
    fn(queries[i]);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { median: (ms[RUNS / 2 - 1] + ms[RUNS / 2]) / 2, p95: ms[Math.ceil(0.95 * RUNS) - 1], min: ms[0] };
}

function latency(dims) {
  const out = [];
  for (const n of LATENCY_SIZES) {
    const { db, path, cleanup } = tempDb("th-bench-");
    try {
      ensureEmbeddingsSchema(db);
      const rand = mulberry32(42);
      const ins = db.prepare(`INSERT INTO command_embeddings (content_hash, model, dims, entry_id, vector) VALUES (?, 'bench', ?, ?, ?)`);
      const tIns = performance.now();
      db.transaction(() => { for (let i = 0; i < n; i++) ins.run(`b${i}`, dims, i, encodeVector(randomUnit(rand, dims))); })();
      const insertMs = performance.now() - tIns;
      db.pragma("wal_checkpoint(TRUNCATE)");
      const bytes = statSync(path).size;

      const queries = Array.from({ length: WARMUP + RUNS }, () => randomUnit(rand, dims));
      const sqlite = timeRuns(queries, (q) => vectorSearch(db, q, "bench", LATENCY_K));

      const tLoad = performance.now();
      const matrix = new Float32Array(n * dims);
      let r = 0;
      for (const row of db.prepare(`SELECT vector FROM command_embeddings WHERE model = 'bench' ORDER BY rowid`).iterate()) {
        matrix.set(decodeVector(row.vector), r * dims);
        r++;
      }
      const loadMs = performance.now() - tLoad;
      const mem = timeRuns(queries, (q) => scanMatrix(matrix, n, dims, q, LATENCY_K));

      // Both paths must return the same neighbours.
      const a = vectorSearch(db, queries[0], "bench", LATENCY_K).map((h) => h.entry_id);
      const b = scanMatrix(matrix, n, dims, queries[0], LATENCY_K).map((h) => h.entry_id);
      if (a.join() !== b.join()) throw new Error(`in-memory scan disagrees with vectorSearch at N=${n}`);

      out.push({ n, insertMs, bytes, sqlite, mem, loadMs });
    } finally {
      cleanup();
    }
  }
  return out;
}

function printLatency(dims, rows) {
  console.log(`\nBrute-force vector search latency  (random unit vectors, d=${dims}, top-${LATENCY_K},`);
  console.log(`median / p95 of ${RUNS} queries after ${WARMUP} warm-up, file-backed SQLite in WAL mode, warm OS cache)`);
  console.log(`${"N".padStart(8)}  ${"vectorSearch (SQLite read + scan)".padEnd(36)} ${"in-memory Float32Array scan".padEnd(30)} DB size`);
  for (const r of rows) {
    const s = `${r.sqlite.median.toFixed(1)} ms / ${r.sqlite.p95.toFixed(1)} ms`;
    const m = `${r.mem.median.toFixed(1)} ms / ${r.mem.p95.toFixed(1)} ms`;
    console.log(`${r.n.toLocaleString("en-US").padStart(8)}  ${s.padEnd(36)} ${m.padEnd(30)} ${(r.bytes / 1e6).toFixed(1)} MB`);
  }
  for (const r of rows) {
    console.log(`  N=${r.n.toLocaleString("en-US")}: inserting took ${r.insertMs.toFixed(0)} ms; loading into memory once took ${r.loadMs.toFixed(0)} ms.`);
  }
}

// ---------------------------------------------------------------- main

console.log("terminal-history-mcp eval");
console.log(`NOTE: the fixture (${fixture.length} commands) and the ${golden.length} queries are synthetic and author-written, not real user data.`);
console.log(`Machine: ${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB, ${platform()}-${arch()}, Node ${process.version}`);

let benchDims = DEFAULT_BENCH_DIMS;
let cfg;
try {
  cfg = readLlmConfig();
} catch (e) {
  console.log(`\nSKIP retrieval-quality eval: ${e.message}`);
}
if (cfg) {
  let probe;
  try {
    [probe] = await embedTexts(cfg, ["probe"], "query");
  } catch (e) {
    console.log(`\nSKIP retrieval-quality eval: no embedding endpoint answered (${e.message}).`);
    console.log(`Start Ollama and run \`ollama pull ${cfg.embedModel}\`, then re-run \`npm run eval\`.`);
  }
  if (probe) {
    benchDims = probe.length;
    printQuality(cfg, await quality(cfg));
  }
}
printLatency(benchDims, latency(benchDims));
