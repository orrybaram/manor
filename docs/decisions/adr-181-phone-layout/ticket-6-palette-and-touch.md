---
title: The palette is full screen, and drags stay off a phone
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# The palette is full screen, and drags stay off a phone

ADR-181 D5.

**The palette.** Ticket 3's palette button opens the existing
`CommandPalette`. In phone mode it is full screen — the list and input fill
the viewport, the input is at the top, results scroll. Style under
`.app[data-layout="phone"]` in `CommandPalette.module.css`. Every pane action
without a touch idiom (split, close, move, detach) must be reachable here;
check that each already is, and add a palette command for any that is not
rather than inventing a phone-only control.

**Drags off.** In phone mode, disable: drag-to-split (`PaneDropZone`,
`PaneDragContext`), dragging a tab (`TabBar`), and detach-by-drag. Disabled,
not hidden behind a flag somewhere else — a drag that half-starts under a thumb
and then scrolls the page is worse than no drag. Read `useLayoutMode()` at the
drag sources.

**Long-press.** Radix `ContextMenu` opens on long-press on touch already.
Verify the pane and tab context menus do, and that a long-press on a terminal
does not also start an xterm text selection that swallows it. If it does,
say so in your report rather than papering over it; ticket 7 owns the
terminal's touch handling.

## Files to touch
- `src/components/command-palette/CommandPalette.module.css` — phone styling
- `src/components/workspace-panes/PaneDropZone.tsx`, `PaneDragContext.tsx` — no drags in phone mode
- `src/components/tabbar/TabBar/*` — no tab drag in phone mode
- `src/components/command-palette/*` — only if a pane action is missing from it

## Folded in from ticket 4

The sidebar now lives in a drawer on a phone, but it still renders its
**desk-mode width-resize handle** — a mouse drag, inside a sheet whose width
is fixed. Add it to this ticket's "drags off in phone mode" list: no resize
handle in phone mode. Also check that `useSidebarDrag`'s project
drag-to-reorder does not swallow a scroll or a long-press inside the drawer;
if it does, disable it in phone mode too, as with the other drags.
