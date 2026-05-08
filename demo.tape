# vhs tape — terminal-history-mcp demo (runs locally on macOS).
# Render: vhs demo.tape  →  demo.gif

Output demo.gif

Set FontSize 14
Set Width 1180
Set Height 660
Set Theme "GitHub Dark"
Set TypingSpeed 24ms
Set Padding 14
Set Framerate 24

# Title
Type "# terminal-history-mcp — search shell history with Claude"
Sleep 1500ms
Enter
Sleep 400ms

# Verify wired
Type "claude mcp list 2>&1 | grep terminal"
Sleep 400ms
Enter
Sleep 2500ms

# Q1
Type "# 1) Find a docker command from weeks ago"
Enter
Sleep 600ms
Type `claude --print --permission-mode bypassPermissions "Use terminal-history MCP search_history with query=docker limit=3. One short line per command."`
Sleep 400ms
Enter
Sleep 14s

# Q2
Type "# 2) What failed recently?"
Enter
Sleep 600ms
Type `claude --print --permission-mode bypassPermissions "Use terminal-history failed_commands(limit=3). Two-line summary."`
Sleep 400ms
Enter
Sleep 12s

# Q3
Type "# 3) What did I run in /etc/nginx?"
Enter
Sleep 600ms
Type `claude --print --permission-mode bypassPermissions "Use terminal-history recent_in_dir cwd=/etc/nginx limit=5. Bullet list."`
Sleep 400ms
Enter
Sleep 12s

# Outro
Type "# Local SQLite + FTS5. Secret-redacted. MIT."
Sleep 2500ms
Enter
Sleep 1200ms
