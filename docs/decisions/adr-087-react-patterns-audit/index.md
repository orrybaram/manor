---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-087: React Patterns Audit — Fix useEffect Violations and Props Patterns

## Context

A full audit of all React components in the codebase revealed widespread violations of the project's React patterns skill:

1. **13 direct `useEffect` calls** across 8 files — `useEffect` is banned per project rules. Mount-only effects should use `useMountEffect`, derived state should be computed inline, and DOM setup should use ref callbacks.
2. **~50 files** use inline props destructuring instead of the prescribed `props` parameter + first-line destructuring pattern.
3. **~13 files** use `interface` instead of `type` for props definitions.
4. **Derived state synced via effect** in LeafPane (webviewFocused).
5. **Manual store subscription** in WorkspaceEmptyState that could be simplified.

## Decision

Fix all violations in 3 tickets:

1. **Ticket 1 — Replace all `useEffect` with proper patterns** (8 files). This is the highest-impact change as `useEffect` violations cause brittleness, infinite loop risk, and debugging pain.
2. **Ticket 2 — Fix props patterns: `interface` to `type`** (~13 files). Mechanical rename.
3. **Ticket 3 — Fix props patterns: inline destructuring to `props` parameter** (~50 files). Mechanical refactor.

## Consequences

- **Better**: All components follow declared patterns — fewer race conditions, easier debugging, consistent code style.
- **Risk**: Purely mechanical changes but touching many files — typecheck verification is critical.
- **Tradeoff**: Large diff for props changes, but the changes are entirely mechanical and low-risk.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
