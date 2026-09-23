---
title: One hook decides the layout mode
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# One hook decides the layout mode

ADR-181 D2. Everything else in this ADR reads one answer to "is this renderer
in phone mode?" — build that answer first, and nothing else.

## What to build

`src/hooks/useLayoutMode.ts` exporting `useLayoutMode(): "phone" | "desk"`.

- `"phone"` when `window.matchMedia("(max-width: 767px)")` matches **and**
  `window.electronAPI.isDetached` is false. A detached window (ADR-179 D4) is
  always `"desk"`: it is often narrow on purpose and already shows one claimed
  tab with no chrome.
- Subscribe to the media query's `change` event; clean up on unmount. Use
  `useSyncExternalStore` so it is tear-free and SSR-safe-shaped.
- Export the breakpoint as a named constant (`PHONE_MAX_WIDTH = 767`) with a
  comment that ADR-178 D9 set "~768 px", and the CSS below uses the same
  number.

Write the answer onto the DOM once: in `App.tsx`, the root `.app` element gets
`data-layout={mode}` (in both the primary render and the detached-window
render — the latter is always `"desk"`). CSS in later tickets keys off
`.app[data-layout="phone"]`; components call the hook.

## Tests

`src/hooks/__tests__/useLayoutMode.test.ts` with a stubbed `matchMedia`:
narrow → phone; wide → desk; narrow but detached → desk; a `change` event
flips it.

## Files to touch
- `src/hooks/useLayoutMode.ts` — new
- `src/App.tsx` — `data-layout` on `.app`, both render paths
- `src/hooks/__tests__/useLayoutMode.test.ts` — new
