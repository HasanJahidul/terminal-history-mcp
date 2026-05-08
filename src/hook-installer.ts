import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";

type Shell = "zsh" | "bash" | "fish";

const MARK_BEGIN = "# >>> terminal-history-mcp hook >>>";
const MARK_END = "# <<< terminal-history-mcp hook <<<";

const ZSH_HOOK = `${MARK_BEGIN}
__th_log_dir="$HOME/.terminal-history-mcp"
[[ -d "$__th_log_dir" ]] || mkdir -p "$__th_log_dir"
__th_preexec() { __TH_START=$EPOCHREALTIME; __TH_CMD="$1"; }
__th_precmd() {
  local rc=$?
  [[ -z "$__TH_CMD" ]] && return
  local now=$EPOCHREALTIME
  local dur=0
  if [[ -n "$__TH_START" ]]; then
    dur=$(( (now - __TH_START) * 1000 ))
  fi
  printf '%s|%d|%.0f|%s|%s\\n' "$EPOCHSECONDS" "$rc" "$dur" "$PWD" "$__TH_CMD" \\
    >> "$__th_log_dir/extended.log"
  __TH_CMD=""
  __TH_START=""
}
zmodload zsh/datetime 2>/dev/null
autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook preexec __th_preexec
  add-zsh-hook precmd __th_precmd
fi
${MARK_END}
`;

const BASH_HOOK = `${MARK_BEGIN}
__th_log_dir="$HOME/.terminal-history-mcp"
[ -d "$__th_log_dir" ] || mkdir -p "$__th_log_dir"
__th_preexec() {
  [ -n "$COMP_LINE" ] && return
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __TH_CMD="$BASH_COMMAND"
  __TH_START=$EPOCHREALTIME
}
__th_precmd() {
  local rc=$?
  [ -z "$__TH_CMD" ] && return
  local dur=0
  if [ -n "$__TH_START" ]; then
    dur=$(awk "BEGIN{printf \\"%.0f\\", ($EPOCHREALTIME - $__TH_START) * 1000}")
  fi
  printf '%s|%d|%s|%s|%s\\n' "$(date +%s)" "$rc" "$dur" "$PWD" "$__TH_CMD" \\
    >> "$__th_log_dir/extended.log"
  __TH_CMD=""
  __TH_START=""
}
trap '__th_preexec' DEBUG
case "$PROMPT_COMMAND" in
  *__th_precmd*) ;;
  *) PROMPT_COMMAND="__th_precmd;\${PROMPT_COMMAND:-:}" ;;
esac
${MARK_END}
`;

const FISH_HOOK = `${MARK_BEGIN}
function __th_preexec --on-event fish_preexec
  set -g __TH_CMD $argv
  set -g __TH_START (date +%s%N)
end
function __th_postexec --on-event fish_postexec
  set -l rc $status
  if test -z "$__TH_CMD"
    return
  end
  set -l now (date +%s%N)
  set -l dur 0
  if test -n "$__TH_START"
    set dur (math "($now - $__TH_START) / 1000000")
  end
  set -l dir $HOME/.terminal-history-mcp
  test -d $dir; or mkdir -p $dir
  echo (date +%s)"|$rc|$dur|"(pwd)"|$__TH_CMD" >> $dir/extended.log
  set -e __TH_CMD
  set -e __TH_START
end
${MARK_END}
`;

function rcPath(shell: Shell): string {
  if (shell === "zsh") return process.env.ZDOTDIR ? join(process.env.ZDOTDIR, ".zshrc") : join(homedir(), ".zshrc");
  if (shell === "bash") return join(homedir(), ".bashrc");
  return join(homedir(), ".config", "fish", "config.fish");
}

function snippet(shell: Shell): string {
  if (shell === "zsh") return ZSH_HOOK;
  if (shell === "bash") return BASH_HOOK;
  return FISH_HOOK;
}

export function printHookSnippet(shell: Shell): string {
  return snippet(shell);
}

export function installHook(shell: Shell): void {
  const path = rcPath(shell);
  const snip = snippet(shell);
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
  const cur = readFileSync(path, "utf-8");
  if (cur.includes(MARK_BEGIN)) {
    console.log(`Hook already installed in ${path}. Use uninstall-hook first to refresh.`);
    return;
  }
  const sep = cur.endsWith("\n") || cur.length === 0 ? "" : "\n";
  appendFileSync(path, sep + snip);
  console.log(`Installed hook in ${path}.`);
  console.log(`Reload your shell: source ${path}  (or open a new terminal)`);
  const logDir = join(homedir(), ".terminal-history-mcp");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

export function uninstallHook(shell: Shell): void {
  const path = rcPath(shell);
  if (!existsSync(path)) {
    console.log(`No rc file at ${path}. Nothing to do.`);
    return;
  }
  const cur = readFileSync(path, "utf-8");
  const begin = cur.indexOf(MARK_BEGIN);
  const end = cur.indexOf(MARK_END);
  if (begin < 0 || end < 0) {
    console.log(`Hook markers not found in ${path}. Nothing to remove.`);
    return;
  }
  const stop = cur.indexOf("\n", end + MARK_END.length);
  const tail = stop < 0 ? "" : cur.slice(stop + 1);
  let head = cur.slice(0, begin);
  if (head.endsWith("\n")) head = head.slice(0, -1);
  writeFileSync(path, head + (tail ? "\n" + tail : "\n"));
  console.log(`Removed hook from ${path}.`);
}
