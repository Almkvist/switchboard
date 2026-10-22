# Design: Status source

## Purpose

An optional, read-only view of your own system for the ops agent: health, what is running now, open alerts, and
events. With one plugged in, the ops agent can answer "is anything running on the database?" from facts instead of
guessing. Switchboard relays and routes what it sees; it never acts on it (P1).

## Public API (`src/status.ts`)

`StatusSource` { `health()`, `live()`, `overview()`, `events({since, kind, run, limit})` }, each returning JSON the
ops agent reads as-is. `StubStatus` returns `{available: false, reason}` for all of them, so the agent says it can't
see the system's status instead of guessing. It is the default.

Ops tools (`src/ops-mcp.ts`): `status_health`, `status_live`, `status_overview`, `status_events(since?, kind?, run?,
limit?)` (limit at most 200).

## Plugging one in

1. Write a class that implements `StatusSource` against your system's read-only API, with `fetch`. Keep each method
   a thin proxy: return what your API returns, trimmed to what a human-facing answer needs.
2. Give it a credential that **can't change anything**. The service holds no production credentials (P1): if your
   API has no read-only scope, add one before connecting it. Read the token from the environment (`config.ts`
   `loadSecrets`), never from `config.yaml`, and keep it out of the engines' environment (`engineEnv` passes only
   what each engine needs).
3. Pass it to `start({ …, status })` in `src/main.ts` (the `status` option; `cli.ts serve` uses the stub today).
4. Return errors as data (`{available: false, reason}`) rather than throwing, so the agent can say what it couldn't
   check.
5. Test it with a fake HTTP server on `127.0.0.1:0`, like the other adapters: no network in tests.

Routing your system's alerts into threads (a `status_alert` event, which `wake.ts` already treats as a wake reason)
and policy checks that depend on live state (say, "wait until traffic is drained") are not built. Until then, a
resource's `note` in config carries such a rule for humans to read.

## Implementation files

- `src/status.ts`.

## Dependencies

None internal.

## Constraints

Read only by construction: the interface has no method that writes, and a real implementation should hold a token
that can't write either.

## Tests

Covered through `test/ops.test.ts` (every `status_*` tool is called).

## Non-goals

No polling, alert routing or containment here. Incidents belong to your own system's tooling.

## Status

Stub. No real client ships with switchboard.
