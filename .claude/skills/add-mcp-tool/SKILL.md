---
name: add-mcp-tool
description: Add or change a tool on switchboard's agent MCP server or the ops MCP server, keeping the trust boundary in the core and the docs in sync.
---

# Add an MCP tool

1. Decide who calls it. Personal agents → `src/agent-mcp.ts`. The ops engine → `src/ops-mcp.ts` (M3).
2. Put the rule in the core, not the tool. Agent tools call a method on `AgentSession` (`src/core.ts`) or
   take the authenticated `Agent` (`src/windows.ts`). The tool body is one line. `agent-mcp.ts` may only
   call `core.forAgent/authenticate/audit/unread` (`npm run check:arch` enforces it).
3. Refuse with `SwitchboardError(code, message)`; the message tells the agent what to do instead.
4. Write the test first in the component's test file: one test that uses the tool as intended and one that
   tries to get around the rule it guards.
5. If the tool name is listed in a test (e.g. the tool list in `test/agent-mcp.test.ts`), update it.
6. Update the component doc's Public API (`docs/design/<component>.md`) and, for agent tools, the
   `clients/*/AGENTS-snippet.md` if agents need to know when to call it.
7. `npm run check`. Paste the output in the PR.
