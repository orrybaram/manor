---
title: The sidebar is a drawer on a phone
status: todo
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
