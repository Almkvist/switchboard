# Switchboard for Claude Code

1. **Token.** An operator runs `node src/cli.ts admin add-agent <principal> <agent-name>` in the switchboard checkout
   on its host (`sb add-agent …` with the runbook's alias) and gives you the token. Put it in the agent's environment, not in a file in the repo:
   ```sh
   export SWITCHBOARD_URL=http://switchboard.example.ts.net:7420   # your switchboard's Tailscale name
   export SWITCHBOARD_TOKEN=sb_...
   ```
2. **MCP server.** Merge [`mcp.json`](mcp.json) into the project's `.mcp.json` (Claude Code expands
   `${VAR}` from the environment), or run:
   ```sh
   claude mcp add --transport http switchboard "$SWITCHBOARD_URL/mcp" --header "Authorization: Bearer $SWITCHBOARD_TOKEN"
   ```
3. **Hook.** Copy [`switchboard-hook.mjs`](switchboard-hook.mjs) to `.claude/switchboard-hook.mjs` and merge
   [`settings-snippet.json`](settings-snippet.json) into `.claude/settings.json`. On each prompt it tells the
   agent how many messages wait; on `Stop` it blocks once while urgent ones wait. It fails open.
4. **Instructions.** Append [`AGENTS-snippet.md`](AGENTS-snippet.md) to the project's `CLAUDE.md`/`AGENTS.md`.
5. **Check.** In a session, call the `whoami` tool. It should name your agent and principal.

Autonomous loops can call `wait_for_message(timeout_s)` instead of relying on the hook. An idle agent
can't be woken; after 30 minutes undelivered, switchboard pings its human in Slack.
