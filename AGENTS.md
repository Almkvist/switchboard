# AGENTS.md

**switchboard**: one always-on service where several principals' AI agents message each other over MCP,
maintenance on shared prod gets human approval in Slack, and one shared ops agent talks to the humans. This file is
the map for contributors, human or agent.

## Map

| Need | Read |
|---|---|
| What it is and how to run it | [`README.md`](README.md) |
| The principles behind the design (P1–P8) | [`docs/design-principles.md`](docs/design-principles.md) |
| The spec | [`docs/plan.md`](docs/plan.md) |
| Code shape, layers, where each trust rule lives | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Local patterns to copy | [`CONVENTIONS.md`](CONVENTIONS.md) |
| Component contracts (read before editing a file) | [`docs/design/index.md`](docs/design/index.md) |
| What to trust, what's thin | [`docs/QUALITY.md`](docs/QUALITY.md), [`docs/plans/known-issues.md`](docs/plans/known-issues.md) |
| Running it (Slack app, tokens, systemd) | [`docs/runbook.md`](docs/runbook.md) |
| The ops agent's system prompt | [`prompts/ops.md`](prompts/ops.md) |
| Reporting a vulnerability | [`SECURITY.md`](SECURITY.md) |

## Commands

```sh
npm ci                 # Node >= 24 (types run natively; no build step)
npm run check          # everything below, in order; this is the gate
npm run typecheck      # tsc, no emit
npm run check:arch     # layering, guarded calls, model ids, secrets, docs routing, principle ids
npm test               # node:test, no network
npm run e2e            # real wiring, fake Slack, fake engines through the real ops MCP
node scripts/smoke-engine.ts claude-api|claude|codex   # manual, on a host with credentials: one real engine (spends tokens)
```

## Workflow

1. Read this file, then find the component in `docs/design/index.md` and read its doc.
2. Make the smallest change that does the task. Keep the trust boundary in code, with a test that tries to
   break it.
3. Run `npm run check`. CI runs the same command on every push and pull request.
4. Update the design doc, `docs/QUALITY.md` or `known-issues.md` only if durable knowledge changed. Stop when
   the task is done.

Repeatable procedures live in [`.claude/skills/`](.claude/skills/) (add an MCP tool, change a design principle).

## Rules for any contributor

1. **The trust boundary lives in code and is tested.** Visibility, approvals, mutes and tokens are enforced by
   the core and the database, never by the prompt. A rule gets a test that tries to break it.
2. **No secrets** in the repo, ever: tokens, keys, real Slack ids, internal hostnames. Secrets come from the
   environment; examples use obviously fake values.
3. **Models are configured.** The ops engine's model id comes from config, and the engines and `check:arch`
   refuse any other (P8). Set the model explicitly; don't add a second one for a gate or classifier.
4. **Keep diffs small** and readable by eye. A new file needs a second user or a new layer; a new dependency must
   delete more code than it adds.
5. **PRs target `main`.** Say what you ran and what it printed.
