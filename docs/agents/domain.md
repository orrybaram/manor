# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (not yet authored — proceed silently if absent).
- **`docs/decisions/`** — read ADRs that touch the area you're about to work in. (Note: this repo uses `docs/decisions/`, not the conventional `docs/adr/`.)

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md                    ← not yet authored
├── docs/decisions/
│   ├── adr-001-linear-issue-detail-subview/
│   ├── adr-002-fix-fg-process-detection-hang/
│   └── ...
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR in `docs/decisions/`, surface it explicitly rather than silently overriding:

> _Contradicts adr-007-pr-popover — but worth reopening because…_
