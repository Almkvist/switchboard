# Design: Core

## Purpose

Owns the data model (plan §3) and every visibility rule (plan §4): principals, agents and their tokens,
threads, participants, the append-only event log, the durable inbox, mutes, relays, and the audit log. All
surfaces (agent MCP, Slack, ops) go through it. It never talks to the network.

## Public API (`src/core.ts`)

- `Core` (trusted callers: Slack bridge, windows, ops, admin CLI)
  - admin: `addPrincipal`, `setSlackUser`, `addAgent`, `issueToken` (rotate), `revokeToken`, `setMute`,
    `setDelegate(principal, agent | null)` (P4: one of its own agents, not revoked; audited), `exportThread`
  - auth: `authenticate(token)` → `Agent | null` (SHA-256, constant-time compare, updates `last_seen_at`)
  - threads: `createThread`, `join` (records the thread's last seq as `joined_seq`), `thread`, `threadBySlack`,
    `threadByKey`, `participants(thread, seq?)` (only those in it for event `seq`: `joined_seq < seq`),
    `agentsOnly(thread, seq?)` (a `chat` thread with an agent and no principal for that event: what P3 keeps
    out of Slack), `opsTextInSlack(thread, text)` (`thread` / `paged` / `agents_only`, what `respond` and `relay`
    return), `agentsThread(key, …)`, `dmThread(principal, slackChannel?)` (the principal's one DM thread with the
    ops agent, `dm:<principal>`; the Slack bridge gives it its channel), `tagged(text)`, `events`
  - items for humans (P3): `addHumanItems(event, principals)`, `humanItem(id)`, `pendingHumanItems(thread?)`,
    `handleHumanItems(ids, told | skipped, outcome)` (once each; only the ops tools call it); `tx(fn)`
  - log: `append(thread, actor, type, body, deliveries)` (event + inbox rows in one transaction, listeners
    after commit), `postMessage` (append + fan-out per mute rules), `onEvent(listener)`
  - lanes: `fanOut`, `muteMode`, `solicited(thread, recipient, sender)` and `solicitedWhy` (`open | never | remuted |
    expired`, which the `muted` refusal names) (P4: the recipient wrote there to the sender
    itself after that mute was last set (by event order: `mutes.set_mark`, the newest event's rowid then) and within `solicitedReplyHours`, default 24, and the sender
    was already in the thread then), `queueRelay`, `pendingRelays`, `relay` (requires a pending request)
  - `delegate(principal)` (P4): the principal's delegate agent while it isn't revoked, else undefined
  - humans: `answerAsk` (only the asked principal, once, and only once the ops agent presented it (P3); steers the
    asking agent, with `presented_as`, the card's line); asks (P3): `addAsk`, `ask(id)`, `askByEvent(thread, seq)`, `pendingAsks(thread?)`, `presentAsk(id,
    text)` (one line ≤ `ASK_TEXT_MAX` 300; at most one open question without options per DM; the asker gets the card event as a deferred item with `note: "presented to
    <human> as: <line>"`; the card in the human's DM for an ask from there, else a new shared thread
    with the human and the asker; only ops-mcp calls it, arch check), `skipAsk(id, reason)` (ops-mcp only),
    `openOptionlessAsk(cardThread)` (the one a DM reply answers, presented within `askExpiryMinutes`, indexed),
    `expireAsks(minutes = askExpiryMinutes)` (the 30 s tick; the asker gets an urgent `ask_not_presented`); `messageAgents(principal,
    text, asked)` (P1: the ops agent passes on what a principal asked to that principal's agents, as steer items in a
    private agents-only thread, ≤ 1000 characters, with `asked`, the principal's own Slack words; only ops-mcp
    calls it, arch check)
  - inbox: `unread`, `takeInbox`, `waitForMail`, `staleInbox`, `markPinged`; `audit`
- `AgentSession` (what one authenticated agent may do; the only thing `agent-mcp.ts` uses):
  `canRead`, `whoami` (with the principal's delegate, whether it is you, and, for the delegate, what lands with it),
  `listAgents`, `sendMessage` (to a human: `forHuman`, P3), `post` (`slack` is always false; in a chat thread a human
  is part of it returns `for_human` and the item ids, P3), `askHuman`, `readInbox`, `waitForMessage`, `readThread`.
- `SwitchboardError(code, message)`: `not_found | forbidden | invalid | conflict | muted`.

`src/db.ts`: `openDb`, `MIGRATIONS` (append-only, `PRAGMA user_version`), `one/all/run`, `tx` (nested
calls join the outer transaction), `afterCommit`.

## Rules it enforces

| Rule | Where |
|---|---|
| An agent reads its own principal's private threads, and shared threads it or its principal participates in. Never a `dm` thread. | `AgentSession.canRead` |
| Cross-principal agent messages in `chat` threads: refused on mute `all`, sent to ops on `relayed_only`, else delivered. P4: an agent that wrote in a thread to an agent of the sender's principal (`body.to`, the core's field) gets that agent's replies in that thread under either mute, if it wrote after that mute was last set (`setMute` marks every row with the newest event's rowid, re-setting too; a clock that ties or steps back can't reopen it) and within `solicitedReplyHours` of its last message to it; no other agent of that side, nobody else, and no other thread. Coordination threads (`window`, `incident`) ignore mutes (P4). Mutes cover agent-to-agent messages only: what the ops agent posts isn't filtered, because it is shared (P4). | `AgentSession.sendMessage`, `Core.fanOut` |
| A new principal is muted both ways with every existing one per `research_lane_default` (default `deny`, P4). | `Core.addPrincipal` |
| Deliveries are `{from_agent, from_principal, body}` plus a provenance note when not from the reader's principal (P4). | `AgentSession.render` |
| Only a principal's own human steers its agents; agents never steer. Answers to `ask_human` always steer the asker. The ops agent steers a principal's agents only through `messageAgents`, in a turn that principal's own Slack message woke (P1), and those items say so in their provenance. | `Core.fanOut`, `Core.answerAsk`, `Core.messageAgents`, `AgentSession.render` |
| Without `thread`, an agent's `send_message` to another agent or to `ops` reuses their pair thread only while it is agents-only; once a human has joined, it starts a new one under the same key (`threadByKey` takes the newest, ties by rowid). The relay threads (`relayreq:`, `relayto:`) follow the same rule. A conversation with a human is always reused. | `Core.agentsThread`, `AgentSession.pairThread`, `Core.queueRelay`, `Core.relay` (P3) |
| Messages to humans are not muted. P3: none reaches Slack. Each is an item for the ops agent: its own human's in that human's DM thread with the ops agent (private, read only in their DM turns), the other principal's in the agent's shared, agents-only thread with the ops agent, with `for_human` (the core's field) so it wakes the ops agent (`wake.ts`). A `post` in a chat thread a human is part of is an item for each of them (a private thread's as a copy in the human's DM). | `AgentSession.forHuman`, `AgentSession.post`, `Core.addHumanItems`, `human_items` (migration 13: handled once, by trigger) |
| P3: `ask_human` posts no card. The question is an ask (migration 14), in the human's DM thread for their own agents' and in the agent's shared thread with the ops agent otherwise, waking the ops agent. It leaves `pending` once: presented (with the ops agent's words, fixed), skipped or expired, each telling the asker; only a presented ask can be answered. | `AgentSession.askHuman`, `Core.presentAsk`, `Core.skipAsk`, `Core.expireAsks`, `Core.answerAsk`, triggers on `asks` |
| P4: what another principal's agent addresses to a human with a live delegate (`send_message`, `ask_human`) goes to the delegate's inbox instead: one deferred message (question and options together), in the sender's and the delegate's agents-only pair thread (never Slack), with `addressed_to`, `tool` and a `note` saying so; a `thread` the sender named is only recorded as `re_thread`. It counts as a message to the human, so no mute blocks it; the delegate's replies follow the mutes, except solicited replies in the asker's thread (within the window, after the mute was last set). A revoked delegate gets nothing. The schema refuses a delegate that isn't the principal's own live agent. | `AgentSession.toDelegate`, `Core.delegate`, `Core.setDelegate` (only `cli.ts` calls it, arch check), triggers in `db.ts` (migration 11) |
| `relay` only passes on a pending relay request, and not if the recipient switched to mute `all`. | `Core.relay` |
| A session opened with a token gets no more mail once that token is revoked or rotated, even inside a held `wait_for_message`: revoke and issue wake its waiters, and the token is checked again before every tool and before the inbox is read. | `Core.issueToken`, `Core.revokeToken`, `AgentSession.requireLiveToken` (every agent tool, `agent-mcp.ts`), `AgentSession.readInbox` |
| Events can't be updated or deleted; `window`/`incident` threads can't be private; `dm` threads can't be shared. | triggers and CHECKs in `db.ts` |

## Implementation files

- `src/db.ts`: schema, migrations, query helpers, transactions. Migration 11: `principals.delegate_agent_id` (P4). Migration 12: `changes` rebuilt for `withdrawn`.
  Migration 13: `human_items` (P3). Migration 14: `asks` (P3); an agent's
  ask_human from before it that was never mirrored or answered becomes a pending ask, so it expires.
- `src/core.ts`: everything above.

## Dependencies

`node:sqlite`, `node:crypto`. Imports only `db.ts`. Must never import Slack, MCP, engines or the status source.

## Constraints

- Every write that delivers mail does event + inbox rows in one `tx`; listeners run after commit.
- Thread ids and error texts never reveal another principal's private thread.
- Bodies ≤ 16 000 chars (`MAX_BODY`).

## Tests

`test/core.test.ts` (one test per rule above), `test/fakes.ts` (`world()` seeds two principals, four
agents, a fake clock).

## Non-goals

No orchestration of research, no per-agent ACLs beyond principals, no message editing or deletion, no
cross-process notifications (the admin CLI writes the DB directly; reads see it on the next request).

## Status

Complete. M2 added windows (separate file, `docs/design/windows.md`); M3 calls `wake.ts` from `append`
and migration 3 (engine sessions, `ops_seen_seq`, `kv`).
