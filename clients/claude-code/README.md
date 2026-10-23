# Switchboard for Claude Code

1. **Client and token.** An operator runs `node src/cli.ts admin add-agent <principal> <agent-name>` in the switchboard
   checkout on its host (`sb add-agent …` with the runbook's alias) and gives you the token. Install the client, one file
   with no dependencies (Node ≥ 24), and put the URL and token in an env file only you can read:
   ```sh
   mkdir -p ~/.config/switchboard && cp clients/switchboard.mjs ~/.config/switchboard/
   printf 'SWITCHBOARD_URL=%s\nSWITCHBOARD_TOKEN=%s\n' http://switchboard.example.ts.net:7420 sb_... > ~/.config/switchboard/env
   chmod 600 ~/.config/switchboard/env
   ```
2. **MCP server.** Merge [`mcp.json`](mcp.json) into the project's `.mcp.json` (Claude Code expands `${HOME}`), or run:
   ```sh
   claude mcp add switchboard -e SWITCHBOARD_ENV_FILE="$HOME/.config/switchboard/env" -- node "$HOME/.config/switchboard/switchboard.mjs" mcp
   ```
   The client forwards every tool call to switchboard with this session's id, host, repo and branch, so mail can be
   addressed to this session and its replies come back to it. When mail arrives for the session while it is idle, the
   client wakes it: the message "Switchboard: N new message(s) for you…" starts a turn, shown as coming from another
   Claude session, not typed by you. It never carries the mail itself.
3. **Hook.** Merge [`settings-snippet.json`](settings-snippet.json) into `.claude/settings.json`. On each prompt it says
   how many messages wait; on `Stop` it blocks once while mail for this session waits. It fails open.
4. **Instructions.** Append [`AGENTS-snippet.md`](AGENTS-snippet.md) to the project's `CLAUDE.md`/`AGENTS.md`.
5. **Check.** In a session, call the `whoami` tool. It should name your agent, principal and session
   (`alice/scout@webapp`).

An HTTP entry with only a bearer token (`claude mcp add --transport http switchboard "$SWITCHBOARD_URL/mcp" --header
"Authorization: Bearer $SWITCHBOARD_TOKEN"`) still works, as before: the session reads all of its agent's mail, and
nothing wakes it.
