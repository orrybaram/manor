---
title: Wire panel split actions, drag-drop, and keybindings
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Wire panel split actions, drag-drop, and keybindings

Connect the panel splitting UX: keybindings, context menu actions, and tab drag-to-edge to create/move panels.

## Keybindings

Add to the keybindings store:

| Command ID | Default binding | Action |
|-----------|----------------|--------|
| `split-panel-right` | `Cmd+\` | Split active panel horizontally (new panel to the right) |
| `split-panel-down` | `Cmd+Shift+\` | Split active panel vertically (new panel below) |
| `focus-next-panel` | `Cmd+Option+Right` | Focus next panel |
| `focus-prev-panel` | `Cmd+Option+Left` | Focus previous panel |
| `close-panel` | (none) | Close active panel (available via command palette) |
| `move-tab-to-next-panel` | (none) | Move active tab to next panel |

## Context menu additions

In `TabButton` (renamed from `SessionButton`) context menu, add:
- "Move Tab to Next Panel" — calls `moveTabToPanel` to the next panel
- "Move Tab to New Panel Right" — splits panel and moves this tab
- "Move Tab to New Panel Down" — splits panel and moves this tab

## Drag-and-drop

Update `PaneDragContext` to support panel-edge drops:
- When dragging a tab to the far left/right/top/bottom edge of the main content area, show a panel drop indicator (half-screen highlight)
- Dropping creates a new panel in that direction with the dragged tab
- When dragging a tab between panels, allow dropping on another panel's tab bar to move the tab there
- When dragging a tab out of a panel that only has one tab, close that panel after the move

## Panel auto-close

When a panel's last tab is closed (via close button or `closeTab`):
- Remove the panel from the panel tree
- Collapse the parent split node
- Focus moves to the nearest sibling panel

## App.tsx keyboard handler updates

- Wire the new command IDs to store actions
- `focusPane` should also update `activePanelId` to the panel containing the focused pane
- When clicking inside a panel's content area, that panel should become active

## Files to touch

- `src/store/keybindings-store.ts` — add new command IDs and default bindings
- `src/store/app-store.ts` — ensure `closeTab` handles panel auto-close, wire `focusPane` to update active panel
- `src/App.tsx` — register new keybinding handlers
- `src/components/tabbar/TabButton.tsx` — add panel-related context menu items
- `src/components/workspace-panes/PaneDragContext.tsx` — extend drag payload for panel-edge drops
- `src/components/panels/LeafPanel.tsx` — handle click-to-focus, panel-edge drop zones
- `src/components/command-palette/` — add panel commands to command palette

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-106): wire panel split actions, drag-drop, and keybindings"

Do not push.
