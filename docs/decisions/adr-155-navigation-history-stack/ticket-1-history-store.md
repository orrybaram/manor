---
title: Navigation history store + Location types
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Navigation history store + Location types

Create a self-contained Zustand store that holds the history of view locations.
It must NOT import `app-store` (avoid a circular dependency) — it deals purely in
`Location` values and index math.

## Behavior

- State: `{ entries: Location[]; index: number; isNavigating: boolean }`.
- `Location` discriminated union (coarse granularity — no `paneId`):
  ```ts
  export type Location =
    | { kind: "surface"; surface: "home" }
    | { kind: "workspace"; workspacePath: string; panelId: string; tabId: string };
  ```
- Helper `locationsEqual(a, b): boolean` — structural equality.
- `record(loc: Location)`:
  - If `loc` equals `entries[index]`, do nothing (dedupe consecutive identical).
  - Otherwise truncate any forward entries (`entries = entries.slice(0, index + 1)`),
    push `loc`, set `index = entries.length - 1`.
- `goBack(): Location | null` — if `index > 0`, decrement index, return the new
  current entry; else return `null`. (Does NOT itself touch `isNavigating` — the
  bridge in ticket 2 owns the guard; expose `setNavigating(v: boolean)`.)
- `goForward(): Location | null` — symmetric.
- Selectors / derived: `canGoBack` (`index > 0`), `canGoForward`
  (`index < entries.length - 1`).
- `reset()` — clear to `{ entries: [], index: -1 }`.
- `setNavigating(v: boolean)`.
- **Do NOT** wrap in `persist` — history resets each launch.

## Tests

Add a unit test alongside (follow existing store test conventions in the repo, if
any; otherwise a `navigation-history-store.test.ts`): record/dedupe,
forward-truncation on record after back, goBack/goForward boundaries,
canGoBack/canGoForward.

## Files to touch
- `src/store/navigation-history-store.ts` — new store + `Location` type + `locationsEqual`.
- `src/store/navigation-history-store.test.ts` — new unit tests (match existing test setup/runner).
