import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { redact } from "./redact.js";

export type Entry = {
  cmd: string;
  ts: number | null;
  shell: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
};

const HOME = homedir();

function hashEntry(e: Entry): string {
  return createHash("sha1").update(`${e.shell}|${e.ts ?? 0}|${e.cmd}`).digest("hex");
}

export function parseZshHistory(text: string): Entry[] {
  const out: Entry[] = [];
  const lines = text.split("\n");
  let buf = "";
  for (const raw of lines) {
    const line = buf ? buf + "\n" + raw : raw;
    if (line.endsWith("\\")) { buf = line.slice(0, -1); continue; }
    buf = "";
    if (!line.trim()) continue;
    const m = line.match(/^: (\d+):(\d+);(.*)$/s);
    if (m) {
      out.push({
        cmd: m[3],
        ts: parseInt(m[1], 10) * 1000,
        shell: "zsh",
        cwd: null,
        exit_code: null,
        duration_ms: m[2] ? parseInt(m[2], 10) * 1000 : null,
      });
    } else {
      out.push({ cmd: line, ts: null, shell: "zsh", cwd: null, exit_code: null, duration_ms: null });
    }
  }
  return out;
}

export function parseBashHistory(text: string): Entry[] {
  const out: Entry[] = [];
  const lines = text.split("\n");
  let pendingTs: number | null = null;
  for (const line of lines) {
    if (!line) continue;
    const tm = line.match(/^#(\d{9,})$/);
    if (tm) { pendingTs = parseInt(tm[1], 10) * 1000; continue; }
    out.push({ cmd: line, ts: pendingTs, shell: "bash", cwd: null, exit_code: null, duration_ms: null });
    pendingTs = null;
  }
  return out;
}

export function loadHistoryFiles(): Entry[] {
  const all: Entry[] = [];
  const zsh = process.env.HISTFILE && process.env.HISTFILE.includes("zsh")
    ? process.env.HISTFILE
    : join(HOME, ".zsh_history");
  const bash = join(HOME, ".bash_history");
  if (existsSync(zsh)) {
    try {
      const txt = readFileSync(zsh, { encoding: "utf-8" });
      all.push(...parseZshHistory(txt));
    } catch {
      const buf = readFileSync(zsh);
      all.push(...parseZshHistory(buf.toString("latin1")));
    }
  }
  if (existsSync(bash)) {
    all.push(...parseBashHistory(readFileSync(bash, "utf-8")));
  }
  return all;
}

export function indexEntries(db: Database.Database, entries: Entry[]): { inserted: number; skipped: number } {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO commands (cmd, ts, shell, cwd, exit_code, duration_ms, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0, skipped = 0;
  const tx = db.transaction((rows: Entry[]) => {
    for (const e of rows) {
      const cmd = redact(e.cmd);
      const h = hashEntry({ ...e, cmd });
      const r = ins.run(cmd, e.ts, e.shell, e.cwd, e.exit_code, e.duration_ms, h);
      if (r.changes > 0) inserted++; else skipped++;
    }
  });
  tx(entries);
  return { inserted, skipped };
}
