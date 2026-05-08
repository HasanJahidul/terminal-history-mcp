#!/usr/bin/env node
// Unified CLI dispatcher. Subcommands:
//   terminal-history-mcp                  → run MCP server (stdio)
//   terminal-history-mcp index            → reindex history files + extended log
//   terminal-history-mcp install-hook ... → install shell hook
//   terminal-history-mcp uninstall-hook ..→ remove shell hook
//   terminal-history-mcp --help

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runServer() {
  await import("./index.js");
}

async function runIndex() {
  await import("./cli-index.js");
}

async function runHook(args: string[]) {
  const { installHook, uninstallHook, printHookSnippet } = await import("./hook-installer.js");
  const sub = args[0];
  const shell = args[1];
  if (sub === "install-hook") {
    if (!shell || !["zsh", "bash", "fish"].includes(shell)) {
      console.error("Usage: terminal-history-mcp install-hook <zsh|bash|fish>");
      process.exit(1);
    }
    installHook(shell as "zsh" | "bash" | "fish");
  } else if (sub === "uninstall-hook") {
    if (!shell || !["zsh", "bash", "fish"].includes(shell)) {
      console.error("Usage: terminal-history-mcp uninstall-hook <zsh|bash|fish>");
      process.exit(1);
    }
    uninstallHook(shell as "zsh" | "bash" | "fish");
  } else if (sub === "print-hook") {
    if (!shell || !["zsh", "bash", "fish"].includes(shell)) {
      console.error("Usage: terminal-history-mcp print-hook <zsh|bash|fish>");
      process.exit(1);
    }
    process.stdout.write(printHookSnippet(shell as "zsh" | "bash" | "fish"));
  }
}

const HELP = `terminal-history-mcp v0.2.0

Usage:
  terminal-history-mcp                          Run MCP server (stdio)
  terminal-history-mcp index                    Reindex history files + extended log
  terminal-history-mcp install-hook <shell>     Install shell hook (zsh|bash|fish)
  terminal-history-mcp uninstall-hook <shell>   Remove installed hook
  terminal-history-mcp print-hook <shell>       Print hook snippet to stdout
  terminal-history-mcp --help                   This help
  terminal-history-mcp --version                Print version

Wire to Claude Code:
  claude mcp add --scope user terminal-history -- terminal-history-mcp
`;

async function main() {
  const [, , ...args] = process.argv;
  const cmd = args[0];

  if (!cmd) return runServer();
  if (cmd === "--help" || cmd === "-h") { process.stdout.write(HELP); return; }
  if (cmd === "--version" || cmd === "-v") { process.stdout.write("0.2.0\n"); return; }
  if (cmd === "index") return runIndex();
  if (cmd === "install-hook" || cmd === "uninstall-hook" || cmd === "print-hook") return runHook(args);

  console.error(`Unknown command: ${cmd}`);
  process.stderr.write(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
