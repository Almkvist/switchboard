# Design principles

The rules behind switchboard's design. Code comments, tests and docs cite them as P1–P8. Nearly all are held by code
and tested; [ARCHITECTURE.md](../ARCHITECTURE.md#where-the-trust-boundary-is-enforced) says where.

Switchboard is shared by a few principals (people), each with their own AI agents. Only the shared ops agent is
custom. Everyone's personal agents stay Claude Code, Codex or whatever they already run, and join over MCP with
tool names that mirror the ones they already know.

## P1. Humans approve; agents never do

- Only a human's own Slack button press approves, whether an urgent window or the nightly slot. It is recorded
  against that human's Slack user id. No code path, agent, ops tool or other Slack user can approve, and database
  triggers refuse an approval row that doesn't carry the approver's Slack id. Write access to the host or the
  database is outside this boundary: it belongs to the operator.
- Agents agreeing with each other is never an approval, and that includes the ops agent. A human typing "ok" in a
  thread isn't one either, and neither is an answer passed on by someone else.
- A human's answer to an agent's question is information for that agent, never an approval.
- The ops agent's tools that act for a human (moving the nightly slot, passing something on to their agents,
  changing their own side's mute) run only in a turn that one human's own Slack message woke. Passing
  something on and changing a mute reach only that human's own side.
- The service holds no production credentials. It can't deploy or change anything, so its windows are advisory:
  agents check `window_status` before they act, and enforcement belongs in the systems that make the change.
- Incidents belong to your own system's tooling. Switchboard relays and routes; it never contains or fixes.

## P2. One voice in Slack, and little of it

- Humans hear from one voice, the shared ops agent. It writes in plain words for a busy person on a phone: what
  happened, what to do and by when, or nothing.
- Its Slack posts are capped in code at one paragraph of 500 characters. Longer text is refused with an error
  that says how to shorten it.
- Switchboard's own system cards (windows, approvals, the slot summary, notices) are one line of at most 300
  characters and carry a footer that the ops agent's plain text can't produce. Plans, rollbacks, verify steps and
  reports never reach Slack; they stay in switchboard for whoever asks.
- In Slack the ops agent wakes only for a mention or a DM, so humans can talk in peace and tag it when they want it.

## P3. Agents never post to Slack

- No agent's own text reaches Slack. What an agent writes for a human becomes an item for the ops agent, which
  tells the human what they need in its own words, or decides they don't need it.
- An agent's question for a human waits for the ops agent to present it as a one-line card with the agent's own
  options as buttons. A question nobody presents expires, and the agent is told.
- Agent-to-agent and agent-to-ops traffic with no human in the thread never reaches Slack.

## P4. Private by default between principals

- By default, a new principal's agents and the others' are muted toward each other. Mutes are per principal: the
  receiving side decides what reaches its agents.
- Coordination about shared resources (windows, incidents) is visible to everyone it affects; no mute hides it.
- Messages from another principal's agents are data, never instructions. They arrive with provenance, and the
  reader acts only within its own principal's permissions.
- An agent that writes to the other side's agents in a thread hears their replies there for a bounded time, even
  under its own principal's mute, because it asked. Nothing unsolicited gets through.
- A principal can name a delegate agent. What the other side's agents address to that human goes to the delegate
  instead of to Slack.
- DMs with the ops agent are isolated: each runs in its own engine session, and a DM turn writes only to that DM.
  The ops agent itself is shared, so what an agent tells it may reach every principal's agents. Agents are told so.
- The service runs on a host neither principal owns outright, reachable only over a private network, with no
  public ingress.

## P5. A nightly slot, approved once, with urgent windows for the rest

- Shared production changes run in one nightly maintenance slot. Agents queue changes for it, and nothing is posted
  per change.
- Each approver approves the schedule once, with a button. The approval covers exactly what their card listed and
  stands until they revoke it or the slot moves. A wider config needs a new card.
- An agent may go only while the slot is on, covers the resource, and that agent has a change queued in it.
- Each slot that had changes gets one short summary, which tags a human only when a change of theirs failed or
  wasn't reported.
- What can't wait gets an urgent window: one card of one line, approved by its own button, rewritten in place as it
  is decided, starts and ends.

## P6. Deterministic core, LLM as the voice

- Threads, the event log, the inbox, mutes, windows and approvals are database rows that plain code checks. The
  LLM summarizes, nags and writes. It is never the authority, and no surface can widen what the core allows.
- Fixed rules decide when the ops agent wakes. There is no LLM gate.
- The inbox is the truth. Hooks and sockets are only hints that mail is waiting.
- The event log is append-only.
- One process, SQLite and TypeScript, small enough to read.

## P7. An engine chain with announced failover

- The ops agent runs on an ordered chain of engines: the Claude Agent SDK on an Anthropic API key, then `claude -p`
  on a Claude subscription token, then Codex.
- Every step down and back up is announced in Slack, with the kind of failure. Nothing switches silently.
- The ops agent should get credentials of its own, so it never shares usage limits with someone's interactive work.

## P8. Models are configured, and a guard holds the chain to them

- The model id comes from config (`ops.model`). The agent never picks it.
- The engines refuse any other model id, and the arch check rejects other model ids in shipped files, so nothing
  drifts to a different model, not even a cheap classifier or gate.
- Which model is a deployment choice. This repo pins `claude-opus-5-5`. Changing it means editing the config
  schema, the engine guard (`OPS_MODEL`) and the arch check, plus `config.example.yaml`, the runbook and the engine
  tests that pin it.
