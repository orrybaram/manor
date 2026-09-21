---
title: The sidebar is a drawer on a phone
status: in-progress
priority: high
assignee: sonnet
blocked_by: [3]
---

# The sidebar is a drawer on a phone

ADR-181 D3. In phone mode the existing `Sidebar` renders inside a left-edge
drawer instead of inline.

- A new `src/components/phone/SidebarDrawer.tsx` built on
  `@radix-ui/react-dialog` (already a dependency): a side sheet from the left,
  ~85 % width, with an overlay; Escape and tapping the overlay close it; focus
  is trapped while open and returned to the drawer toggle on close.
- Open state comes from ticket 3's drawer toggle.
- **It closes itself when a workspace (or Home) is chosen** — the user asked to
  go somewhere, so take them there. Hook the close onto the sidebar's existing
  workspace-select path rather than duplicating selection logic.
- The sidebar's content is the same `Sidebar` component. Moving it between
  parents remounts it, which is fine — it holds no terminals.
- Drag-to-reorder in the sidebar (`useSidebarDrag`) is mouse-driven; leave it
  as is. A thumb gets the sidebar's context menus on long-press (Radix).

Desk mode unchanged.

## Files to touch
- `src/components/phone/SidebarDrawer.tsx` — new
- `src/App.tsx` — render the drawer in phone mode
- `src/components/sidebar/Sidebar/*` — only if an `onNavigate` hook is needed to close the drawer

## Folded in from ticket 3

**The phone top bar collides with the macOS traffic lights on the desktop.**
D2 puts the *desktop window* in phone mode when it is dragged narrow. The
window uses an inset title bar, so the red/yellow/green buttons sit over the
top-left of the page — exactly where ticket 3's drawer toggle now is. Ticket 3
reset the tab strip's old 78 px traffic-light padding (correctly: the tab
strip no longer touches the top edge in phone mode), and nothing gave that
room to the new top bar.

Fix, in `PhoneTopBar` / `Phone.module.css`:
- On the Electron desktop (`window.electronAPI.platform === "electron"`) on
  macOS, left-pad the top bar to clear the traffic lights — use the same inset
  the tab strip used, not a new magic number.
- Make the top bar a **window drag region** (`-webkit-app-region: drag`), as
  `Sidebar.module.css` does, so a narrow desktop window can still be moved.
  `<Button>` is already `no-drag`, so its buttons stay clickable — verify.
- In a browser: no inset, no drag region.

It is small, and it lands here because this ticket already edits the phone
chrome's surroundings. Say in your report what you could not check visually.

## Also from ticket 3

The drawer's open state already exists in `App.tsx` as `_phoneDrawerOpen` /
`setPhoneDrawerOpen` (underscore-prefixed because nothing read it yet). Drop
the underscore now that you read it.
