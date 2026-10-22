# Design: Agent MCP server

## Purpose

The MCP endpoint personal agents (Claude Code, Codex) connect to over Tailscale. Tool names mirror Claude
Code's. It holds no rules of its own: every tool calls `AgentSession`.

## Public API

HTTP (`createAgentHttpServer`), bound to `listen.host:listen.port` (the Tailscale IP in prod):

| Route | Auth | Purpose |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer sb_…` | MCP Streamable HTTP, stateless, JSON responses |
| `GET /unread` | bearer | `{unread, steer}` for the client hooks |
| `GET /healthz` | none | `{ok: true}` |

Tools (`buildAgentMcp`): `whoami`, `list_agents`, `send_message(to, body, thread?)`,
`read_inbox(limit?)`, `wait_for_message(timeout_s≤600)`, `post(thread, body)` (never Slack, P3: `slack` is always false;
in a chat thread a human is part of, `for_human` names the humans the ops agent reads it for),
`read_thread(thread, after_seq?, limit?)`, `ask_human(who, question, options?)`. `send_message` to a human goes to the ops
agent, which tells them what they need (P3: `via: 'the ops agent'`, an `item` id). `send_message` and `ask_human` to the
other principal's human go to that human's delegate agent if they set one (P4: the result's `via` names it, no card,
no buttons); `whoami` shows the caller's principal's delegate.
With `windows` (M2, P5): `request_window(resource, plan, rollback, verify, start?, duration_minutes?, urgent?, title?)`
(without `urgent` it queues a change for the nightly slot; with it, an urgent window of its own, whose one-line Slack
card shows `title`, at most 80 characters, by default the plan's first sentence, P2),
`window_status(id | resource)`, `report_window(id, outcome, evidence)` (`id` a change `c_…` or a window `w_…`);
see [windows.md](windows.md).

Results are JSON text. Refusals are `isError` results reading `<code>: <what to do instead>`.

## Implementation files

- `src/agent-mcp.ts`: HTTP routing, bearer auth, tool registration, `toolResult` (error mapping, shared
  with the ops MCP server in M3).

## Dependencies

`@modelcontextprotocol/sdk`, `zod`, `core.ts`, `windows.ts`. It may call only `core.authenticate`, `core.forAgent`,
`core.audit` and `core.unread` (arch check).

## Constraints

- One `McpServer` per request, bound to the agent the token names. Every tool checks the token is still
  live right before it runs (a request authenticated just before a revoke runs nothing), and a
  `wait_for_message` already held checks again before it hands over mail: `forbidden` either way.
- `requestTimeout = 0` because `wait_for_message` holds a request for up to 600 s.
- Every authenticated tool call is written to `audit` (bodies omitted); every failed auth too.

## Tests

`test/agent-mcp.test.ts` (real HTTP on `127.0.0.1:0`), `test/clients.test.ts` (hook against `/unread`).

## Non-goals

No SSE notifications to agents (hooks and `wait_for_message` cover delivery), no OAuth, no per-tool scopes.

## Status

Complete for M1 and M2.
