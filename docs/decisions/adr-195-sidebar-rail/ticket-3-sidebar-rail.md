---
title: SidebarRail component with project tiles and workspace popover
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# SidebarRail component with project tiles and workspace popover

See ADR-195 §2 (`docs/decisions/adr-195-sidebar-rail/index.md`) for the full spec. Follow `.claude/rules/ui-components.md`: use `<Button>` and `<Tooltip>` from `src/components/ui/`, never a raw `<button>`. Match the look of `Sidebar.module.css` and `ProjectItem.module.css` (tokens such as `--dim`, `--border`, `--surface`, `--accent`, `--project-color`).

Build `src/components/sidebar/SidebarRail/`:
- `SidebarRail.tsx` + `SidebarRail.module.css`: a 52px column with `data-focus-region="sidebar"`, the same background and right border as `.sidebar`, and a 32px drag spacer at the top.
  - Below the spacer: the Home tile, a divider, and a scrollable tile column over `buildTopLevelEntries(projects)`.
  - At the bottom: an Agents button (count of the agents `AgentsList` shows, so extract a small hook or selector from `AgentsList.tsx` rather than duplicating its filter; the click calls the `onShowAgents` prop) and `<NotificationsPopover />`.
  - Props: `onShowAgents`.
- `RailProjectTile.tsx`: tile, tooltip, color, `railTileLabel`, status badge (`useProjectAgentStatus` / `useGroupAgentStatus` → `toWorkspaceIndicator` → `WorkspaceIndicatorDot`, positioned in the bottom-right corner, scaled for the tile), and the active marker. Put the project and group cases in separate small components so the hooks aren't called conditionally. `isSelected` follows `Sidebar.tsx`: `!homeActive` and the entry holds `projects[selectedProjectIndex]`.
- `RailWorkspacePopover.tsx`: a Radix `Popover` (see `PrPopover.tsx` for the portal and styling pattern), `side="right"` `align="start"`, triggered by the tile. It renders `railWorkspaceRows(entry)`:
  - host rows use the ADR-193 host heading (export `SectionHostLabel` from `ProjectItem.tsx` or move it to its own file)
  - folder rows are dim sub-labels indented by depth
  - workspace rows show `workspaceDisplayName`, a `WorkspaceIndicatorDot` from `useWorkspaceAgentStatus(workspaceKey(project.hostId, ws.path))`, and the selected style when it's `activeWorkspacePath` on the active host (the same rule as ProjectItem's `onActiveHost`)
  - clicking a row does what the full sidebar does (`selectProject(idx)` + `selectWorkspace(project.id, project.workspaces.indexOf(ws))`), then closes the popover
- Keyboard: roving focus across the rail's buttons with ↑/↓ (reuse `useRovingRows` if it fits, otherwise a small local handler). `focus-sidebar` lands on the active tile, or Home. Enter or Space opens the popover.

Wire it up:
- `src/App.tsx`: render `<SidebarRail onShowAgents={() => setAgentsOpen(true)} />` when `sidebarMode === "rail" && hasProjects`.
- `src/components/tabbar/TabBar/TabBar.tsx` + `.module.css`: in `rail` mode use a new `.railSidebar` class (`padding-left: 26px`, so tabs clear the traffic lights that extend past the 52px rail) instead of `.noSidebar`.

Check it by running the app if you can (see the `run` skill), or at least by typecheck and build. Make sure a linked group tile opens a popover with both host sections.

## Files to touch
- `src/components/sidebar/SidebarRail/SidebarRail.tsx`, `SidebarRail.module.css`, `RailProjectTile.tsx`, `RailWorkspacePopover.tsx` — new
- `src/components/sidebar/ProjectItem.tsx` — export the host heading
- `src/components/sidebar/AgentsList.tsx` — extract visible-agents hook
- `src/App.tsx` — render the rail
- `src/components/tabbar/TabBar/TabBar.tsx`, `TabBar.module.css` — rail inset
