import type Database from "better-sqlite3";

export type SearchRow = {
  id: number;
  cmd: string;
  ts: number | null;
  shell: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  rank?: number;
};

function escapeFts(q: string): string {
  const tokens = q.split(/\s+/).filter(Boolean).map((t) => {
    const cleaned = t.replace(/["']/g, "");
    if (!cleaned) return "";
    if (/^[A-Za-z0-9_-]+$/.test(cleaned)) return cleaned + "*";
    return `"${cleaned}"`;
  }).filter(Boolean);
  return tokens.join(" OR ");
}

export function searchHistory(db: Database.Database, query: string, limit = 20): SearchRow[] {
  const fts = escapeFts(query);
  if (!fts) return [];
  const stmt = db.prepare(`
    SELECT c.id, c.cmd, c.ts, c.shell, c.cwd, c.exit_code, c.duration_ms, commands_fts.rank AS rank
    FROM commands_fts
    JOIN commands c ON c.id = commands_fts.rowid
    WHERE commands_fts MATCH ?
    ORDER BY rank LIMIT ?
  `);
  return stmt.all(fts, limit) as SearchRow[];
}

export function recentInDir(db: Database.Database, cwd: string, limit = 20): SearchRow[] {
  const stmt = db.prepare(`
    SELECT id, cmd, ts, shell, cwd, exit_code, duration_ms FROM commands
    WHERE cwd = ? ORDER BY ts DESC NULLS LAST LIMIT ?
  `);
  return stmt.all(cwd, limit) as SearchRow[];
}

export function failedCommands(db: Database.Database, sinceTs: number | null, limit = 20): SearchRow[] {
  const stmt = db.prepare(`
    SELECT id, cmd, ts, shell, cwd, exit_code, duration_ms FROM commands
    WHERE exit_code IS NOT NULL AND exit_code != 0
      AND (? IS NULL OR ts >= ?)
    ORDER BY ts DESC LIMIT ?
  `);
  return stmt.all(sinceTs, sinceTs, limit) as SearchRow[];
}

export function commandChains(db: Database.Database, query: string, windowMs = 5 * 60 * 1000, limit = 10): SearchRow[][] {
  const seeds = searchHistory(db, query, limit);
  const out: SearchRow[][] = [];
  const ctx = db.prepare(`
    SELECT id, cmd, ts, shell, cwd, exit_code, duration_ms FROM commands
    WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
  `);
  for (const s of seeds) {
    if (s.ts == null) { out.push([s]); continue; }
    const rows = ctx.all(s.ts - windowMs, s.ts + windowMs) as SearchRow[];
    out.push(rows);
  }
  return out;
}
