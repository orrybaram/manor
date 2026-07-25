---
title: Shared detach-drag geometry + drag-image helpers
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Shared detach-drag geometry + drag-image helpers

Extract the pure, stateless pieces the native-DnD tear-off needs into a new
`src/lib/detach-drag.ts`, so the pane handler (ticket 3) can share identical
geometry and an identical drag chip with the tab handler instead of duplicating
subtle logic.

## What to create — `src/lib/detach-drag.ts`

Pure functions (no React, no store):

```ts
export interface Bounds { x: number; y: number; width: number; height: number; }
export interface WindowInfo { id: number; bounds: Bounds; }

/** True when a screen point is clearly outside `bounds` (with a small margin). */
export function isOutsideWindow(sx: number, sy: number, b: Bounds, margin = 8): boolean

/** Topmost window whose bounds contain the point, or null. `windows` is already
 *  ordered topmost-first (as `window.listWindows()` returns). */
export function findWindowAtPoint(sx: number, sy: number, windows: WindowInfo[]): WindowInfo | null

/** Spawn bounds for a torn-off window so the grabbed chip lands under the cursor. */
export function spawnBoundsFor(
  sx: number, sy: number, grab: { x: number; y: number },
  size?: { width: number; height: number },   // default 900x600
): Bounds
```

Also move the drag-image builder here, generalized so both tabs and panes render
an identical chip:

```ts
/** Build the OS drag image element (styled as an app tab/pane chip) for
 *  DataTransfer.setDragImage. Caller appends briefly, then removes. */
export function buildDragImage(
  className: string,                 // the CSS module class to apply
  title: string,
  contentType: string | undefined,  // "browser" | "diff" | terminal
  favicon: string | undefined,
): HTMLDivElement
```

Move `GLOBE_SVG` / `DIFF_SVG` and the `buildTabDragImage` body here as the basis
for `buildDragImage` (parameterize the class name so the caller passes its own
CSS-module class). Keep a terminal has-no-icon default, matching today.

## Files to touch
- `src/lib/detach-drag.ts` — NEW. The four helpers above. No imports from React
  or the store; only DOM + plain types.

## Notes
- Do NOT modify `TabBar.tsx` in this ticket — leave the shipped tab tear-off
  untouched. `buildTabDragImage` in `TabBar` can stay as-is; the new
  `buildDragImage` is what ticket 3 uses. (A later cleanup may switch TabBar over,
  out of scope here.)
- Match the existing hit-test semantics in `TabBar.handleTabDrag` /
  `handleTabDragEnd` precisely so pane and tab behavior are identical.
