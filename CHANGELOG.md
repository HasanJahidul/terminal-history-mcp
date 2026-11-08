# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional semantic search over an OpenAI-compatible endpoint (default: local Ollama at `http://localhost:11434/v1`, `nomic-embed-text`).
- `search_history` `mode` input: `keyword` (default, unchanged output), `semantic`, `hybrid` (top 50 FTS5 + top 50 vector, Reciprocal Rank Fusion k=60). Hybrid falls back to keyword and reports `fallback_reason` when embeddings are unavailable.
- `reindex_embeddings(limit=2000)` tool: embeds distinct command text in batches of 64 into a new `command_embeddings` table, keyed by content hash and model.
- `ask_history(question, k=8)` tool: answers from retrieved history with `[id:N]` citations validated against the retrieved set; exact "No relevant history found." when nothing is relevant; context-only without a chat model.
- Env vars `TERMINAL_HISTORY_LLM_BASE_URL`, `TERMINAL_HISTORY_EMBED_MODEL`, `TERMINAL_HISTORY_CHAT_MODEL`, `TERMINAL_HISTORY_LLM_API_KEY`, `TERMINAL_HISTORY_ALLOW_REMOTE_LLM`. Non-localhost endpoints are refused unless the last is `1`.
- `npm run eval`: recall@5 / MRR@10 per mode on a synthetic fixture, plus brute-force vector search latency at 10k and 100k vectors. See `docs/adr/0001-semantic-search.md`.
- Unit tests for vectors, RRF, reindexing, the guardrail and ask_history; a hermetic JSON-RPC e2e suite (temp HOME, fake endpoint on 127.0.0.1).

## [0.2.0] - 2026-05-08

### Added
- 5 MCP tools: `search_history`, `recent_in_dir`, `failed_commands`, `command_chains`, `reindex`.
- Pre-insert secret redaction: GitHub PATs (`ghp_*`/`gho_*`/etc), OpenAI keys (`sk-*`), Slack tokens (`xox[baprs]-*`), AWS keys (`AKIA*`), `Authorization: Bearer/Basic` headers, generic `X-*-Token`/`X-*-Key`/`X-*-Secret`/`X-*-Auth`/`X-*-ApiKey` headers, env vars containing `TOKEN`/`KEY`/`SECRET`/`PASSWORD`/`API_KEY`, CLI flags (`--token=`/`--api-key`/etc), URL basic-auth, JWTs.
- Optional shell hook captures `cwd`, `exit_code`, `duration_ms` via `~/.terminal-history-mcp/extended.log` (offset-tracked, incremental).
- Hook installer CLI: `install-hook | uninstall-hook | print-hook` for zsh, bash, fish.
- Unified bin: `terminal-history-mcp [index|install-hook|uninstall-hook|print-hook|--help|--version]`.
- 23 unit tests (node:test) for redaction, parser, search.
- GitHub Actions CI matrix: Node 18/20/22 × Ubuntu/macOS.
- MIT license.

### Notes
- Default zsh/bash history files do NOT store cwd or exit code. Run `terminal-history-mcp install-hook <shell>` to enable `recent_in_dir` and `failed_commands` for newly-run commands.
- Storage is local SQLite at `~/.terminal-history-mcp/history.db`. Nothing is uploaded.

[0.2.0]: https://github.com/HasanJahidul/terminal-history-mcp/releases/tag/v0.2.0
