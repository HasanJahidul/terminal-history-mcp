import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { redact } from "./redact.js";

// Hook line format (pipe-delimited, one per command):
//   <unix_ts>|<exit>|<duration_ms>|<cwd>|<cmd>
// cmd may contain pipes; use limit of 4 splits.

const LOG_PATH = join(homedir(), ".terminal-history-mcp", "extended.log");
const STATE_PATH = join(homedir(), ".terminal-history-mcp", ".extended.offset");

export type ExtEntry = {
  ts: number;
  exit_code: number;
  duration_ms: number;
  cwd: string;
  cmd: string;
};

function parseLine(line: string): ExtEntry | null {
  if (!line || line[0] === "#") return null;
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < 4; i++) {
    const idx = rest.indexOf("|");
    if (idx < 0) return null;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  const ts = parseInt(parts[0], 10);
  const exit = parseInt(parts[1], 10);
  const dur = parseFloat(parts[2]);
  if (!Number.isFinite(ts) || !Number.isFinite(exit)) return null;
  return {
    ts: ts * 1000,
    exit_code: exit,
    duration_ms: Number.isFinite(dur) ? Math.round(dur) : 0,
    cwd: parts[3],
    cmd: parts[4],
  };
}

export function ingestExtendedLog(db: Database.Database): { applied: number; inserted: number } {
  if (!existsSync(LOG_PATH)) return { applied: 0, inserted: 0 };

  let offset = 0;
  if (existsSync(STATE_PATH)) {
    const v = parseInt(readFileSync(STATE_PATH, "utf-8").trim(), 10);
    if (Number.isFinite(v)) offset = v;
  }
  const size = statSync(LOG_PATH).size;
  if (size < offset) offset = 0; // log rotated/truncated
  if (size === offset) return { applied: 0, inserted: 0 };

  const fd = readFileSync(LOG_PATH);
  const slice = fd.subarray(offset).toString("utf-8");

  const lines = slice.split("\n");
  // last line may be partial — keep its bytes for next run
  const tail = slice.endsWith("\n") ? "" : lines.pop() ?? "";
  const consumed = size - Buffer.byteLength(tail, "utf-8");

  const updateByHash = db.prepare(`
    UPDATE commands SET cwd = ?, exit_code = ?, duration_ms = ?
    WHERE hash = ? AND (cwd IS NULL OR exit_code IS NULL)
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO commands (cmd, ts, shell, cwd, exit_code, duration_ms, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let applied = 0, inserted = 0;
  const tx = db.transaction((rows: ExtEntry[]) => {
    for (const e of rows) {
      const cmd = redact(e.cmd);
      // Try to match existing zsh/bash row by (shell, ts, cmd) — but we don't know shell here.
      // Try both common shells.
      let updated = false;
      for (const shell of ["zsh", "bash", "fish"]) {
        const h = createHash("sha1").update(`${shell}|${e.ts}|${cmd}`).digest("hex");
        const r = updateByHash.run(e.cwd, e.exit_code, e.duration_ms, h);
        if (r.changes > 0) { applied++; updated = true; break; }
      }
      if (!updated) {
        // Insert as a new "ext" entry; shell unknown but mark as 'ext'.
        const h = createHash("sha1").update(`ext|${e.ts}|${cmd}`).digest("hex");
        const r = insert.run(cmd, e.ts, "ext", e.cwd, e.exit_code, e.duration_ms, h);
        if (r.changes > 0) inserted++;
      }
    }
  });

  const parsed: ExtEntry[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const p = parseLine(t);
    if (p) parsed.push(p);
  }
  tx(parsed);

  writeFileSync(STATE_PATH, String(consumed));
  return { applied, inserted };
}
