# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary (Agent, Agent kind, Agent status, Status signal, etc.).
- **`docs/decisions/`** — read ADRs that touch the area you're about to work in. (Note: this repo uses `docs/decisions/`, not the conventional `docs/adr/`.)

There are 200+ ADRs. Don't read them all — find relevant ones by grepping folder names and contents (`ls docs/decisions | grep <topic>`, `grep -rl <term> docs/decisions`). Each ADR's `index.md` frontmatter has a `status:` (`proposed` / `accepted` / `superseded`); ignore `superseded` decisions unless tracing history.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/decisions/
│   ├── index.md                              ← database view, not a summary
│   ├── adr-001-linear-issue-detail-subview/
│   │   ├── index.md                          ← the decision
│   │   └── ticket-1-*.md                     ← implementation tickets
│   ├── adr-002-fix-fg-process-detection-hang/
│   └── ...
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids (e.g. say **Agent**, not "task").

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR in `docs/decisions/`, surface it explicitly rather than silently overriding:

> _Contradicts adr-007-pr-popover — but worth reopening because…_
