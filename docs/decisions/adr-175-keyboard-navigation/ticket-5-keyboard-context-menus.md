---
title: Open context menus from the keyboard
status: done
priority: high
assignee: sonnet
blocked_by: [3, 4]
---

# Open context menus from the keyboard

1. New `src/lib/keyboard-context-menu.ts`:
   - `isContextMenuKey(e)` → Shift+F10, `e.key === "ContextMenu"`, or
     Meta+`.` (no shift/alt/ctrl).
   - `openContextMenuFromKeyboard(el)` → dispatch
     `new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY, button: 2 })`
     with coords at the element's bottom-left (+4px). Unit test it (jsdom).
2. Wire into: sidebar row handler (`openMenu` hook from ticket 3), tabs
   (ticket 4 hook), "+" tab button, sidebar agent rows (`AgentsList.tsx`),
   port badges (ticket 6 makes them focusable — if not yet focusable, still
   add the handler).
3. Make sure Meta+. on a focused row/tab is handled locally and
   `preventDefault` + `stopPropagation` so the global dispatcher doesn't also
   see it (copy-branch is Meta+Shift+. so no clash, but check).
4. Every Radix `ContextMenu.Content` touched: `onCloseAutoFocus` returns focus
   to the trigger element when the menu was opened by keyboard (keep a ref);
   otherwise keep current behaviour (don't steal focus after mouse use).
   Verify Radix focuses the first item / content on open so arrows work.

## Files to touch
- `src/lib/keyboard-context-menu.ts` (new) + test
- `src/lib/sidebar-row.ts`, `src/components/sidebar/ProjectItem.tsx`, `FolderItem.tsx`, `Sidebar.tsx`, `AgentsList.tsx`
- `src/components/tabbar/TabButton.tsx`, `TabBar.tsx`
- `src/components/ports/PortBadge.tsx`
