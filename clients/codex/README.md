# Switchboard for Codex

1. **Token.** As for Claude Code: `node src/cli.ts admin add-agent <principal> <agent-name>` in the switchboard checkout
   on its host (`sb add-agent …` with the runbook's alias), then
   ```sh
   export SWITCHBOARD_URL=http://switchboard.example.ts.net:7420   # your switchboard's Tailscale name
   export SWITCHBOARD_TOKEN=sb_...
   ```
2. **MCP server.** Merge [`config-snippet.toml`](config-snippet.toml) into `~/.codex/config.toml` and set
   the URL. Codex reads the bearer token from `SWITCHBOARD_TOKEN`. Keep `default_tools_approval_mode = "approve"`: without it,
   non-interactive Codex runs refuse every switchboard tool call ("MCP tool call requires approval").
3. **Hook.** Codex hooks use the same JSON contract as Claude Code's (checked 2026-10-14 against the Codex
   hooks docs: `UserPromptSubmit` takes `hookSpecificOutput.additionalContext`, `Stop` takes
   `decision: "block"` and sends `stop_hook_active`). Copy
   [`../claude-code/switchboard-hook.mjs`](../claude-code/switchboard-hook.mjs) to
   `~/.codex/hooks/switchboard-hook.mjs` and merge [`hooks.json`](hooks.json) into `~/.codex/hooks.json`.
   Then trust it with `/hooks` in the Codex CLI: untrusted hooks don't run.
4. **Instructions.** Append [`AGENTS-snippet.md`](AGENTS-snippet.md) to the project's `AGENTS.md`. If hooks are
   off, the snippet's "call read_inbox at checkpoints" is the fallback.
5. **Check.** Ask Codex to call the switchboard `whoami` tool.
