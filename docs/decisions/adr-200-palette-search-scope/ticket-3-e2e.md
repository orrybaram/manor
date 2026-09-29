---
title: E2E coverage for palette scope
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# E2E coverage for palette scope

Add `tests/e2e/command-palette-scope.spec.ts`, modelled on
`tests/e2e/command-palette-frequent.spec.ts` (reuse its fixtures/helpers for
launching the app and seeding projects). Seed at least two projects.

Cases:
1. With a project workspace active, ⌘K opens with the project chip; the other
   project's workspace group is absent.
2. Backspace twice on the empty input → chip reads "All projects"; the other
   project's workspaces appear.
3. Tab toggles back to the project chip.
4. Clicking the sidebar Search row opens with "All projects".
5. On the Dashboard, ⌘K opens with "All projects".
6. Scoped search for the other project's workspace name shows the
   "matches in other projects" empty state; ⌘↵ widens and shows it.

Add `data-testid`s in `ScopeChip.tsx` / the footer if needed
(`palette-scope-chip`, `palette-scope-footer`). Run the new spec and make it
pass.

## Files to touch
- `tests/e2e/command-palette-scope.spec.ts` — new
- `src/components/command-palette/ScopeChip.tsx` — test ids if missing
