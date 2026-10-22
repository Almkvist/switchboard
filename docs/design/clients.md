# Design: Client kits

## Purpose

What a personal agent needs to join: MCP config, a hook that says "mail is waiting", and an AGENTS.md
snippet with the rules (plan §10). Nobody changes their personal setup beyond this.

## Public API

- `clients/claude-code/`: `README.md`, `mcp.json` (`${SWITCHBOARD_URL}`, `${SWITCHBOARD_TOKEN}`),
  `settings-snippet.json` (hooks), `switchboard-hook.mjs`, `AGENTS-snippet.md`.
- `clients/codex/`: `README.md`, `config-snippet.toml` (`bearer_token_env_var`), `hooks.json`,
  `AGENTS-snippet.md`. Uses the same hook script: Codex hooks share Claude Code's JSON contract.

The hook reads stdin (`hook_event_name`, `stop_hook_active`), calls `GET /unread`, and prints:
`UserPromptSubmit` → `hookSpecificOutput.additionalContext`; `Stop` with steer items and not already
continued → `{decision: "block", reason}`; anything else → `{}`. It fails open.

## Implementation files

- `clients/claude-code/switchboard-hook.mjs` (plain JS, no dependencies, Node ≥ 18), plus the snippets.

## Constraints

No secrets in snippets: the token comes from the agent's environment.

## Tests

`test/clients.test.ts` runs the hook against the real HTTP server.

## Non-goals

No client library or SDK. No waking idle agents (impossible; the service pings the human instead, M2).

## Status

Complete for M1, M2 and the nightly slot (P5; the AGENTS snippets: queue with `request_window`, go on `window_status`, report with
the change id, urgent only for what can't wait; an urgent `ops` item your principal asked for, P1).
