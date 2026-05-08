# terminal-history-mcp

Search your shell history (zsh / bash / fish) from Claude Code, Cline, Cursor, Zed, or any MCP client. Local-only. SQLite FTS5. Secret-redacted before storage.

## What you can ask

- *"When did I last ssh into the staging server?"*
- *"Show recent failed commands."*
- *"What did I run yesterday in `/etc/nginx`?"*
- *"What's that long docker compose flag I used 3 weeks ago?"*
- *"Show command chains around `kubectl apply`."*

## Install

```bash
npm install -g terminal-history-mcp
terminal-history-mcp index           # one-time backfill from existing history
```

(Or run from a clone: `git clone … && npm install && npm run build && npm link`.)

### Wire to Claude Code

```bash
claude mcp add --scope user terminal-history -- terminal-history-mcp
claude mcp list
```

### Wire to other MCP clients

Anywhere that takes a stdio MCP server config:

```json
{
  "mcpServers": {
    "terminal-history": {
      "command": "terminal-history-mcp"
    }
  }
}
```

## Capture cwd + exit code (recommended)

By default zsh/bash history files store only the command. To unlock `recent_in_dir` and `failed_commands`, install the shell hook:

```bash
terminal-history-mcp install-hook zsh    # or bash, or fish
exec $SHELL                              # reload
```

The hook appends pipe-delimited lines to `~/.terminal-history-mcp/extended.log`. Reindex picks them up.

To inspect the snippet first:

```bash
terminal-history-mcp print-hook zsh
```

To remove:

```bash
terminal-history-mcp uninstall-hook zsh
```

## Tools

| Tool | What it does |
|------|--------------|
| `search_history(query, limit)` | FTS5 keyword + prefix match across all history |
| `recent_in_dir(cwd, limit)` | Last N commands in a working dir (needs hook) |
| `failed_commands(since_ts_ms, limit)` | Commands with non-zero exit (needs hook) |
| `command_chains(query, window_ms, limit)` | For each match, list commands within ±5 min |
| `reindex` | Re-parse history files + extended log |

## Privacy

Everything is local. The DB lives at `~/.terminal-history-mcp/history.db`. Nothing is uploaded.

Secrets are scrubbed **before** insert. Detected patterns:

- GitHub PATs (`ghp_*`, `gho_*`, …)
- OpenAI keys (`sk-*`)
- Slack tokens (`xox[baprs]-*`)
- AWS access keys (`AKIA…`)
- `Authorization: Bearer/Basic <value>`
- `X-*-Token: …`, `X-*-Key: …`, `X-*-Secret: …` headers
- Env vars containing `TOKEN` / `KEY` / `SECRET` / `PASSWORD` / `API_KEY`
- CLI flags `--token=…`, `--api-key …`, `-k …`
- URL basic-auth `https://user:pass@host`
- JWTs (`eyJ.*.*`)

If you find a leak, please open an issue. To wipe and re-index after upgrading patterns:

```bash
rm ~/.terminal-history-mcp/history.db*
terminal-history-mcp index
```

## Development

```bash
git clone https://github.com/hasanjahidul/terminal-history-mcp
cd terminal-history-mcp
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](LICENSE).
