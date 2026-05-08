import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DATA_DIR = join(homedir(), ".terminal-history-mcp");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, "history.db");

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cmd TEXT NOT NULL,
      ts INTEGER,
      shell TEXT,
      cwd TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      hash TEXT UNIQUE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
      cmd,
      cwd,
      content='commands',
      content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS commands_ai AFTER INSERT ON commands BEGIN
      INSERT INTO commands_fts(rowid, cmd, cwd) VALUES (new.id, new.cmd, COALESCE(new.cwd,''));
    END;
    CREATE TRIGGER IF NOT EXISTS commands_ad AFTER DELETE ON commands BEGIN
      INSERT INTO commands_fts(commands_fts, rowid, cmd, cwd) VALUES('delete', old.id, old.cmd, COALESCE(old.cwd,''));
    END;
    CREATE INDEX IF NOT EXISTS idx_ts ON commands(ts);
    CREATE INDEX IF NOT EXISTS idx_cwd ON commands(cwd);
    CREATE INDEX IF NOT EXISTS idx_exit ON commands(exit_code);
  `);
  return db;
}
