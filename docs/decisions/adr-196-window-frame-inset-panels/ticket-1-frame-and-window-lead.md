---
title: Frame, WindowLead and sidebar panel
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# Frame, WindowLead and sidebar panel

Read ADR-196 (`docs/decisions/adr-196-window-frame-inset-panels/index.md`) sections 1–3 and the Sidebar/Rail bullets of section 4. This ticket builds the frame and the left side. Ticket 2 does the tab bars and panel bodies.

## Steps

1. **Helpers** (`src/lib/window-lead.ts`): export `LEAD_COMPACT_WIDTH = 150`, `RAIL_WIDTH = 52` (reuse an existing constant if one exists), `windowLeadWidth(mode, sidebarWidth)` and `windowLeadInset(mode, sidebarWidth)` as defined in the ADR. Add `topLeftPanelId(node)` to `src/store/panel-tree.ts`. Unit-test all three next to existing tests (`src/lib/__tests__` or colocated, follow what's there).
2. **Frame**: in `src/App.css` set `.app` background to `var(--bg-deep)`, add `--frame-gap: 6px` and `--window-lead-inset: 78px` to `:root`. `electron/window.ts`: both `BrowserWindow`s get `trafficLightPosition: { x: 13, y: 14 }` and a `backgroundColor` equal to the default theme's `--bg-deep` (`#1e1e2e` mixed 80% with black ≈ `#181825`).
3. **WindowLead** (`src/components/window-lead/WindowLead/WindowLead.tsx` + `.module.css`): absolutely positioned top-left of `.app-body` (make `.app-body` `position: relative`), height 40px, width from `windowLeadWidth`, drag region with `no-drag` buttons. Contents: 78px spacer, sidebar toggle (`lucide-react` `PanelLeft`, `toggleSidebarRail` from project-store, `<Tooltip>` with the `toggle-sidebar` binding label the way other tooltips format shortcuts), back, forward, and in `full` mode `<NotificationsPopover />` at the right end. Move the back/forward block out of `Sidebar.tsx` as-is (labels, disabled state, `navigateBack`/`navigateForward`). Use `<Button variant="ghost">` and `<Tooltip>` per `.claude/rules/ui-components.md`.
4. **App.tsx**: render `<WindowLead />` inside `.app-body` when `hasProjects` (same condition as the sidebars; when there are no projects, still render it so back/forward and the lights spacer exist — decide by checking what the no-project screen shows and keep it clean). Set `style={{ "--window-lead-inset": `${windowLeadInset(...)}px` }}` on `.app-body`.
5. **Sidebar** (`Sidebar.tsx`, `Sidebar.module.css`): remove the `.titlebar` row and its now-unused styles. Wrap so the sidebar starts 40px from the top with `var(--frame-gap)` on its left and bottom, and style it as a panel: `var(--dim)` background, `1px solid var(--border)`, `border-radius: 8px`, no `border-right`. The width stored in `sidebarWidth` should still be the visible panel width. Move `SidebarResizeHandle` so it sits in the gutter on the panel's right edge and still resizes correctly.
6. **Rail** (`SidebarRail.module.css`): transparent background, no `border-right`, `.dragSpacer` 40px.

## Files to touch
- `src/lib/window-lead.ts` — new helpers
- `src/store/panel-tree.ts` — `topLeftPanelId`
- tests for the above
- `src/App.css` — frame background, `--frame-gap`, `--window-lead-inset`, `.app-body` positioning
- `src/App.tsx` — render `WindowLead`, set inset variable
- `src/components/window-lead/WindowLead/WindowLead.tsx`, `WindowLead.module.css` — new
- `src/components/sidebar/Sidebar/Sidebar.tsx`, `Sidebar.module.css` — drop titlebar, panel styling
- `src/components/sidebar/SidebarRail/SidebarRail.module.css` — transparent rail, 40px spacer
- `src/components/sidebar/SidebarResizeHandle/*` — reposition into gutter
- `electron/window.ts` — traffic light y, background color
