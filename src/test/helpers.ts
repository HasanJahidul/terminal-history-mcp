// Deterministic fakes for semantic-search tests. No network.
import Database from "better-sqlite3";
import { ensureEmbeddingsSchema } from "../embeddings.js";
import { NO_RELEVANT_ANSWER } from "../semantic-search.js";
import type { ChatFn, ChatMessage, EmbedFn } from "../llm.js";

// Same commands/FTS schema as the other suites, plus the embeddings table.
export function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE commands (id INTEGER PRIMARY KEY AUTOINCREMENT, cmd TEXT NOT NULL, ts INTEGER, shell TEXT, cwd TEXT, exit_code INTEGER, duration_ms INTEGER, hash TEXT UNIQUE);
    CREATE VIRTUAL TABLE commands_fts USING fts5(cmd, cwd, content='commands', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER commands_ai AFTER INSERT ON commands BEGIN
      INSERT INTO commands_fts(rowid, cmd, cwd) VALUES (new.id, new.cmd, COALESCE(new.cwd,''));
    END;
  `);
  ensureEmbeddingsSchema(db);
  return db;
}

export function seed(db: Database.Database, cmds: string[]): void {
  const ins = db.prepare(`INSERT INTO commands (cmd, ts, shell, hash) VALUES (?, ?, 'zsh', ?)`);
  cmds.forEach((cmd, i) => ins.run(cmd, 1_700_000_000_000 + i * 60_000, `h${i}`));
}

// Words map to shared "concept" dimensions, so paraphrases ("free up disk space" vs "prune")
// land close together the way a real embedding model would put them. Unknown words add a
// small hashed component, so unrelated text is not identical.
const CONCEPTS: Record<string, number> = {
  docker: 0, container: 0, containers: 0, image: 0, images: 0,
  prune: 1, free: 1, clean: 1, cleanup: 1, disk: 1, space: 1, reclaim: 1, remove: 1,
  git: 2, rebase: 2, commit: 2, commits: 2, branch: 2, squash: 2,
  kubectl: 3, pod: 3, pods: 3, cluster: 3, kubernetes: 3, forward: 3,
  ssh: 4, server: 4, remote: 4, login: 4,
  npm: 5, install: 5, package: 5, dependencies: 5,
};
export const FAKE_DIMS = 16;

function wordHash(w: string): number {
  let h = 5381;
  for (let i = 0; i < w.length; i++) h = ((h << 5) + h + w.charCodeAt(i)) >>> 0;
  return h;
}

export function fakeEmbedOne(text: string): number[] {
  const v = new Array<number>(FAKE_DIMS).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const c = CONCEPTS[w];
    if (c !== undefined) v[c] += 1;
    else v[8 + (wordHash(w) % 8)] += 0.25;
  }
  if (!v.some((x) => x !== 0)) v[FAKE_DIMS - 1] = 1;
  return v;
}

export function fakeEmbedder(calls?: string[][]): EmbedFn {
  return async (texts) => {
    calls?.push([...texts]);
    return texts.map(fakeEmbedOne);
  };
}

// Answers "No relevant history found." for questions about Paris/France/bananas, otherwise
// answers citing the first entry in the context block.
export function fakeAnswer(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const question = /^Question: (.*)$/m.exec(user)?.[1] ?? "";
  if (/paris|france|banana/i.test(question)) return NO_RELEVANT_ANSWER;
  const first = /^\[id:(\d+)\]/m.exec(user)?.[1];
  return first ? `You ran it as shown in [id:${first}].` : NO_RELEVANT_ANSWER;
}

export function fakeChat(seen?: ChatMessage[][]): ChatFn {
  return async (messages) => {
    seen?.push(messages);
    return fakeAnswer(messages);
  };
}
