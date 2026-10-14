---
title: The selected project index is translated to the merged list
status: todo
priority: medium
assignee: sonnet
blocked_by: [6]
---

# The selected project index is translated to the merged list

ADR-230 D7 (gap R3).

## What to build

In `src/bridge/router.ts`, only when not in pass-through:
- When `merged()` answers `projects.getAll` (`mergeProjects`, :835-877),
  remember home's raw id order (from home's own answer) and the merged id
  order.
- **`projects.getSelectedIndex`:**
  - ask home;
  - map its index to an id through home's order, then to the merged index;
  - if the id isn't in the merged list, clamp to 0 (or -1 when the list is
    empty), as today's empty case does.
- **`projects.select(i)`:**
  - map merged `i` to an id, then to home's index, and forward that;
  - if home doesn't hold the project, don't call home. Keep the selection
    in the router, so the next `getSelectedIndex` returns `i`.
- If `getAll` hasn't been merged yet, refresh it first, or pass through
  unchanged.

## Tests (each must fail on the base commit)

`src/bridge/__tests__/router.test.ts`, in the phone describe, with home
listing `[a, b]` and a box adding `c` in the middle of the merged order or
at the end:
- home's selected index 1 (`b`) comes back as `b`'s merged index;
- `select(mergedIndexOf(b))` sends home 1;
- `select(mergedIndexOf(c))` doesn't call home, and `getSelectedIndex`
  then returns `c`'s merged index;
- pass-through (a desktop window with no direct bridges) is unchanged.

## Files to touch
- `src/bridge/router.ts`
- `src/bridge/__tests__/router.test.ts`
