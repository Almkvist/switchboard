# Design: Slack

## Purpose

The human interface (P2). Posts what humans must see into Slack (P3), routes Slack messages and button
presses into the core. Bolt in Socket Mode, so the host needs no public ingress (P4).

## Public API (`src/slack.ts`)

- `SlackPort`: `post`, `update`, `ephemeral`, `openDm`. Implemented by `BoltSlack` and by `FakeSlack`
  (`test/fakes.ts`).
- `SlackBridge`
  - `start()` subscribes to core events; `sync(thread)` posts unmirrored events in order (per-thread
    promise chain); `sweep()` retries threads whose `slack_synced_seq` lags.
  - `onMessage(InboundMessage)`, `onAction(InboundAction)`: inbound routing.
  - `render(thread, event)`: the Slack text (and blocks) for one event, or null.
  - `opsText(text)`: escapes ops text and turns `@alice` into a real mention (`Core.tagPattern`: not
    `@alice/scout`, not an email like `ops@alice.example`, never inside a code span or fence).
- `escapeSlack`: escapes `& < >` so agent text can't ping `@channel` or forge `<@U…>`.

## What reaches Slack (P3)

Only what humans must see. An **agents-only thread** is a `chat` thread with at least one agent and no
principal among its participants (`Core.agentsOnly`): agents talking to each other or to the ops agent.
Both this and "a human is part of the thread" are decided per event by seq (`participants(thread, seq)`,
`joined_seq`, migration 7), so a human who joins later doesn't pull what was written before into Slack.

| Event | Slack |
|---|---|
| A human's own Slack message | already there, never re-posted |
| An agent's message to a human (`send_message(to: 'alice')`) | never (P3): an item for the ops agent, which tells the human in its own words (`tell_human`); or, for another principal's agent writing to a human with a delegate, the delegate's inbox (P4) |
| `ask_human` | never (P3): it waits for the ops agent. Another principal's agent asking a human with a delegate: one message in the delegate's inbox, no card (P4) |
| `ask_presented` (the ops agent's `present_ask`, P3) | the question card: the ops agent's one line (tagging the human outside their DM), capped at 300 characters, with the asking agent's own options as buttons (`sb_ask_<i>`, valued with the ask's own thread and seq); in the human's DM for an ask from their own agents, else a new #ops post. The answer rewrites that card with the same line, nothing else is posted |
| An agent's `post` in a `chat` thread a human is part of | never (P3): an item for each of those humans; the ops agent's `respond` there, or `tell_human`, is how they hear |
| Any other agent message (agents-only threads, agent posts in window and incident threads); relay requests | never. `post` always returns `slack: false` |
| An ops agent message | in a thread a human is part of: yes. In an agents-only thread: only if it tags a human (a page) |
| `tell_human` (P3) | in a DM turn, a top-level message in that human's DM; in a shared turn, a new top-level #ops post that tags them, whose replies reach the agents its items came from |
| Window and incident cards, notices | yes, as system cards with the footer; nothing from an agents-only thread |
| An urgent window's request | one line (P2) that tags who must approve: resource, time, title, who asked, and the resource's standing rule as one clause; Approve / Decline. Never the plan, rollback or verify |
| An urgent window's decision, start, end, expiry and report | never a post: each rewrites the window's card in place (`chat.update`, `render` → `replaceRoot`) as one line, buttons gone once decided (P5, P2). A report is its outcome in one word, never its evidence. If Slack can't edit the card for good (`message_not_found`, `cant_update_message`, `edit_window_closed`), the change is posted under it; a transient failure waits for the sweep |
| A window's overdue page; a `failed` report | one short reply under its card that tags the requester's human (`render` → `also` for the report, next to the card's rewrite), no evidence |
| A standing-approval card (P5) | a top-level card in #ops, one line (P2), that tags its approver, with Approve / Decline; each decision, and a new schedule, rewrites it in place |
| The nightly maintenance time changed | one top-level system notice in #ops |
| `card_rerender` (`node src/cli.ts admin rerender-cards`, P2) | never a post: rewrites the thread's root card as it stands now (its newest card event, `rootCard`), in the current format and with that state's buttons. A card Slack can't edit stays as it was (`rewriteOnly`) |
| A queued change, its report, the slot starting or ending | never (P5) |
| A slot that had changes, after its end + grace | one top-level system notice: each change and its outcome, ≤ 260 characters before its tags become mentions; tags the human of a change `not_reported` or `failed`, first, so the 300 cap only ever cuts the end of the list (P2) |

## Where a thread shows up

| Thread | Slack |
|---|---|
| `shared` | a thread in the `#ops` channel (`slack.ops_channel`). No header post: its root is the first message it shows (a window card, an agent's message to the other human, a question card) |
| `shared`, agents-only | nothing, until the ops agent pages a human from it: that message is a new top-level post and becomes the root; later pages go under it, everything else still reaches only the agents, until a human replies there and joins |
| `private:P` with `principal:P` participating | a thread in P's DM with the bot, rooted the same way |
| `private:P` agent-to-agent only | never (plan §9) |
| `dm` | top-level messages in P's DM with the bot. One the core opened (P3: the ops agent tells P what their agents wrote) before P ever wrote to the bot gets its channel from `openDm` on its first post |

Inbound: only Slack users that are principals count, in plain messages, thread broadcasts and messages
with a file (`file_share`); edits, joins and bot messages are skipped. `#ops` messages are logged only in known threads, or
when they mention the bot (which starts a shared thread). DM messages go to the principal's `dm` thread,
or to the private thread whose Slack thread they reply in. A DM message in the `dm` thread also answers the open
question without options presented there within `ask_expiry_minutes` (`Core.openOptionlessAsk`, then `answerAsk` with
its text), so it reaches the asker as a `human_answer`; not a message that mentions the bot, nor an empty or
oversized one, and a refusal is logged, never thrown. `presentAsk` keeps it to one such question per DM. Human messages are appended with
`{via: 'slack', mentions_bot, mentions}` so wake rules (M3) can be deterministic. A human who replies in a
Slack thread joins that switchboard thread, a page's included: the thread is theirs too from then on, and
what the agents and the ops agent post there shows in Slack. A message Slack delivers
twice (a Socket Mode redelivery) is logged once, so it wakes the ops agent once: `(thread, slack_ts)` is
checked before appending.

Buttons: `sb_ask_<i>` answers `ask_human` via `core.answerAsk` (only the asked human, only once the ops agent
presented it, P3) and rewrites the card with the ops agent's line and the answer (a card from before migration 14 keeps the
agent's quoted question); the `human_answer` event itself isn't posted. If that update fails, the answer is
posted as a reply under the card instead.
`sb_win_approve|decline` → `windows.decideFromSlackButton`, the only approval path; the mirror rewrites
the window's card with the decision (a partial one is also told to the clicker). A card the ops agent re-posted
(`request_approval`) is rewritten by the button handler itself, so its buttons go too. Cards no longer carry
"Suggest another time" (P2); `sb_win_suggest` on a card posted before still routes while the window is proposed, and
rewrites the card's line. On any other window it is refused, and the card is left as it is.

What a window card says, one line each (P2; `windowAsk`, `windowUpdate`):

```text
:wrench: <@approver> Core API and DB, 13:23–14:08 UTC: `raise API rate limits` (claude, Alice's agent)
:white_check_mark: Core API and DB, 13:23–14:08 UTC: `raise API rate limits`. Approved by Alice.
:construction: …. In progress until 14:08.          :hourglass_flowing_sand: …. Ended, waiting for the report.
:white_check_mark: …. Done.   :leftwards_arrow_with_hook: …. Rolled back.   :x: …. Failed.   :warning: …. Partial.
:heavy_minus_sign: …. Expired, not approved.         :no_entry: …. Declined by Bob.
```

A window on another day than its request names the date (`Oct 16 09:00–09:30 UTC`). A partial approval keeps
the buttons (`Approved by Bob; waiting for Alice.`). The title is the window's `title` (P2), the plan's
first sentence when the agent gave none.
`sb_std_approve|decline|revoke` (value: the card id) → `windows.decideStandingFromSlackButton`, the only
standing-approval path (P5); the mirror rewrites the card (approved: Revoke; declined or revoked: Approve; void: no
buttons). A supplementary card names what the config now also needs the approver for, inline, "and N more"
past 120 characters. One line each (P2; `standingCard`); what a card approves is its stored pairs, which
`list_maintenance` shows in full:

```text
:calendar: <@approver> Nightly maintenance 21:00–23:00 UTC for 4 shared resources (Alice's and Bob's agents). Approve once?
:calendar: <@approver> Nightly maintenance also needs your OK for Network and security groups (Alice's agents).
:calendar: Nightly maintenance 21:00–23:00 UTC. Approved by Alice.        (a supplementary card: "…UTC, also for <names>. …")
:calendar: Nightly maintenance 21:00–23:00 UTC. Revoked by Alice.   /   Declined by Alice.   /   Void: the slot moved to 22:00–00:00 UTC.
```

## Implementation files

- `src/slack.ts`: port, bridge, Bolt adapter.
- `src/db.ts` migration 6: drops the old mirror's header roots of chat threads with no human in them (P3).

## Dependencies

`@slack/bolt`, `core.ts`, `windows.ts`. Never the ops agent: it reacts to core events instead.

## Constraints

- A thread's Slack target (and a DM's `openDm`) is resolved only once one of its events renders, so a DM thread holding
  only agent items (P3) opens no DM and a failing `openDm` isn't retried for them.
- Mirror is idempotent per event seq; a failed post stops that thread's sync until the next sweep. A
  message Slack refuses for good (`invalid_blocks`, `msg_too_long`, …) is posted once as plain text
  instead, and the mirror moves on; rate limits, outages and channel errors keep waiting for the sweep.
- A reply whose Slack root is gone (deleted; `thread_not_found`, `message_not_found` or
  `cannot_reply_to_message`, since Slack documents no error for it) is posted again as a new top-level post,
  which becomes the thread's root, instead of being retried forever.
- Section text is clipped to Slack's 3000-char limit after escaping, never cutting an `&amp;` in half, nor an emoji
  (`fit` counts UTF-16 units, Slack's count, but cuts whole code points).
- **Every system card, summary and notice is capped at 300 characters (`CARD_MAX`, P2)**, text and section alike,
  after escaping and mention expansion, with an ellipsis that never cuts an entity or a `<@U…>` mention in half. `card()`
  applies it, and every system card goes through `card()`. The renderers aim well under it (an urgent card is about 200);
  the cap holds whatever an agent or the config wrote. Ops text keeps its own 500-character cap (P2, `ops-mcp.ts`), and agent messages
  and `ask_human` cards keep the 3000 section limit: they aren't system cards.
- The Bolt Web API client times out after 10 s and retries twice (Bolt's default is no timeout and about
  30 minutes of retries); a post that still fails is left to `sweep()`.
- A window card is one line (P2): the plan, rollback, verify and report evidence are never rendered, whatever
  their length; they stay in the window row and the thread's events (`read_thread`, `window_status`, the ops agent's
  tools, `export-thread`). The resource name, title and standing rule are each clipped.
- Agent text never reaches Slack (P3): `render` returns nothing for an agent's message. The only agent words in a
  card are a window's title (below) and a presented question's options, the asking agent's own, as its buttons (P3). Ops text is always escaped; the ops agent may tag humans as `@alice`, converted to
  real mentions.
- A window's title is the only agent text inside a system card (P2), so it is shown as inline code (`agentWords`):
  its own backticks become quotes and its emoji are taken out, so no emoji, `:shortcode:` or mrkdwn in it renders
  beside the core's words (a title like `ok :white_check_mark: *Approved by Bob*` reads as quoted code).
- Every system card (window request and approval request, every rewrite of a window card, the overdue page, a
  failed report's reply, notice) ends with a `context` block reading `switchboard`. The ops agent's
  top-level engine announcements are notices too, each in its own thread (P7), so the sweep retries them.
  Text the core didn't write inside a card (a memory edit's `reason`, an engine error's `detail`) is collapsed
  to one line, capped and quoted, so it can't add a line beside the footer that passes for the core's.
  Ops messages are posted as plain text, never blocks, so the LLM can't post a line that passes for a real
  approval or decision, and needs no label of its own (P3). A card Slack refuses is re-posted as plain
  text without the footer (K20).
- Bot scopes: `chat:write`, `im:write`, `im:history`, `channels:history` (or `groups:history`),
  `users:read`; Socket Mode with an app-level token (`connections:write`). See `docs/runbook.md` (M3).

## Tests

`test/slack.test.ts`.

## Non-goals

No slash commands, no modals, no Slack canvases, no reading channels other than `#ops` and DMs.

## Status

Complete for M1, M2 (window rendering and approval buttons), P2 and P3.
