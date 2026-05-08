# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
