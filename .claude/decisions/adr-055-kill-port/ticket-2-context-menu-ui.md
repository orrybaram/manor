---
title: Add Kill Port context menu item to PortBadge
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add Kill Port context menu item to PortBadge

Add a "Kill Port" option to the PortBadge right-click context menu with a separator to visually distinguish the destructive action.

## Implementation

In `src/components/PortBadge.tsx`:

1. Add a `handleKillPort` callback that calls `window.electronAPI.ports.killPort(port.pid)`.

2. Add a `ContextMenu.Separator` and a new `ContextMenu.Item` for "Kill Port" after the existing menu items. Use the existing `contextMenuSeparator` CSS class for the separator. Style the kill item with `color: var(--red)` to indicate it's destructive.

The existing context menu structure:
- Open in Browser Tab
- Open in Default Browser
- --- (separator)
- Kill Port (red text)

## Files to touch
- `src/components/PortBadge.tsx` — add kill port handler and context menu item
- `src/components/Sidebar.module.css` — only if `contextMenuSeparator` class doesn't exist yet
