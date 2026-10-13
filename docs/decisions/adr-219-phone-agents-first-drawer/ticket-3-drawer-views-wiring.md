---
title: Drawer views and New agent / Settings wiring
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Drawer views and New agent / Settings wiring

Per ADR-219 Decision §3–4.

- `SidebarDrawer.tsx`: add `onNewAgent` and `onOpenSettings` props. Add local state `view: "agents" | "projects"` (default `"agents"`), reset to `"agents"` whenever `open` becomes false (do it in the `onOpenChange` path, not an effect, if possible). `"agents"` renders `PhoneAgentsPanel` (`onOpenProjects={() => setView("projects")}`, `onNavigate={() => onOpenChange(false)}`). `"projects"` renders a header row with a back `Button` ("Agents", chevron-left icon, test id `drawer-back-to-agents`) above the existing `<Sidebar … />`, unchanged. Keep the swipe-to-close/edge-swipe hooks and the Radix setup as they are. Update the doc comment to mention ADR-219.
- `SidebarDrawer.module.css`: any styles the back header needs; make sure the sheet's flex layout lets `PhoneAgentsPanel` fill the height with its bottom area pinned.
- `PhoneChrome.tsx`: accept `onNewAgent` and `onOpenSettings`, forward both to `SidebarDrawer`, each closing the drawer first (as the other handlers do).
- `App.tsx`: pass `onNewAgent={handleNewAgent}` and `onOpenSettings={() => handleOpenSettings()}` to `PhoneChrome`. Make sure `SettingsModal` renders in phone layout (it appears to be outside the layout switch — confirm).

## Files to touch
- `src/components/phone/SidebarDrawer.tsx`
- `src/components/phone/SidebarDrawer.module.css`
- `src/components/phone/PhoneChrome.tsx`
- `src/App.tsx`
