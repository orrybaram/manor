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

# ADR-051: Remove unnecessary useEffects

## Context

The codebase has 11 raw `useEffect` calls. Per React's "You Might Not Need an Effect" guidance and the project's own `useMountEffect` docstring (which states we are "progressively banning useEffect"), 6 of these can be eliminated entirely using event handlers, render-time logic, store subscriptions, or component keys.

The remaining 5 are legitimate: external system subscriptions (Electron IPC, DOM events), post-commit DOM manipulation, and timer-based debounce. One of those (`useAutoUpdate`) should be converted from raw `useEffect` to `useMountEffect` for consistency.

## Decision

Remove or refactor the following 6 useEffects:

1. **App.tsx:116** — `applyProjectTheme` on project change. Move theme application into the Zustand store action that changes the selected project, eliminating the React-side effect entirely.

2. **useTerminalHotkeys.ts:20** — Zustand `subscribe` to keep `bindingsRef` updated. Replace with render-time ref assignment (`bindingsRef.current = bindings`), matching the pattern used everywhere else in the codebase.

3. **CommandPalette.tsx:90** — Check Linear/GitHub connection status when `open` changes. Move the async checks into the `onOpenChange` handler so they fire as an event consequence, not a state sync.

4. **CommandPalette.tsx:103** — Reset state when palette closes. Move resets into the `onClose` callback, which already exists and is the natural place for cleanup.

5. **GitHubIssuesView.tsx:33** — Notify parent of empty state via `onEmptyChange`. Replace with a render-time ref-guarded call: track `prevEmpty` in a ref, call `onEmptyChange` only when the value actually changes.

6. **LinearIssuesView.tsx:39** — Same pattern as #5.

Additionally, convert `useAutoUpdate.ts` from raw `useEffect` to `useMountEffect` for consistency (addToast is a stable Zustand selector).

## Consequences

- **Better**: Fewer effects = fewer re-render cycles, simpler mental model, less risk of stale-closure bugs
- **Better**: Aligns with the project's stated goal of banning `useEffect`
- **Risk**: Moving connection checks to event handlers means they fire synchronously with the open action — but since they're async (Promise-based), this is fine
- **Risk**: Render-time `onEmptyChange` calls must be ref-guarded to avoid infinite loops — but this is a well-understood pattern

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
