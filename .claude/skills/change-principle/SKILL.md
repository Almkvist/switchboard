---
name: change-principle
description: Record a design choice made while building switchboard, or propose changing one of the principles in docs/design-principles.md.
---

# Change a design principle

- `docs/design-principles.md` (P1–P8) is what the code holds to. Don't quietly deviate from it in a change.
- A choice you made while building (an interpretation, a default you picked): say so in the PR description under
  "Decisions taken", with the choice and why.
- A principle that looks wrong: don't deviate. Open an issue or a PR that edits `docs/design-principles.md` itself,
  says what changes and why, and updates the code, tests and docs that cite it in the same PR.
- Keep the principles short: what holds, not who decided it or when. Code comments cite them by id (`P3`).
