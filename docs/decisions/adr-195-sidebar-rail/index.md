---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-195: Collapsed sidebar rail

## Context

The sidebar has two states. `sidebarVisible` in `src/store/project-store.ts` is either true (the full 160–400px tree) or false, and when false `App.tsx` unmounts `<Sidebar>` entirely. `⌘\` (`toggle-sidebar`) flips it.

Hiding the sidebar to get horizontal room for panes throws away the signals it carries at a glance: which project is active and, most importantly, whether an agent in some workspace is working, needs input, or has an unread reply. You have to reopen the full sidebar to find out, which reflows every terminal twice.

We explored six collapsed designs (icon rail, rail with hover overlay, workspace rail, compact list, tab bar status, edge peek). The user chose the plain **project icon rail**: a narrow strip with one tile per project, a status badge on each tile, and a click popover listing that project's workspaces.

## Decision

### 1. Sidebar mode replaces `sidebarVisible`

`project-store` gets `sidebarMode: "full" | "rail" | "hidden"`, persisted in localStorage under `manor:sidebarMode` (default `"full"`, same try/catch load pattern as `loadSidebarWidth`). `sidebarVisible` is removed and every reader migrates:

| Caller | Today | After |
|---|---|---|
| `App.tsx` | renders `<Sidebar>` when visible | `full` → `<Sidebar>`, `rail` → `<SidebarRail>`, `hidden` → nothing |
| `TabBar.tsx` | `.noSidebar` when hidden | `.noSidebar` when hidden; new `.railSidebar` inset when `rail` (the macOS traffic lights at x=13 run past the 52px rail) |
| `DetachedApp.tsx` | `setState({ sidebarVisible: false })` | `setState({ sidebarMode: "hidden" })` (plain `setState`, so the popout never writes the persisted key) |
| `menu-handlers.ts` `ensureSidebarVisible` | shows sidebar | sets `full`. Rename/merge/delete flows live in `ProjectItem`, which the rail doesn't mount |
| `useCommands.tsx` `focus-sidebar` | shows sidebar, focuses it | if `hidden`, restores the last visible mode; then focuses the `sidebar` region (rail or full) |

Actions:
- `setSidebarMode(mode)` sets and persists the mode.
- `toggleSidebarRail()` switches `full` ↔ `rail`; from `hidden` it goes to `full`. Bound to the existing `toggle-sidebar` keybinding id (`⌘\`), relabelled "Collapse Sidebar".
- `toggleSidebarHidden()` switches `hidden` ↔ the last visible mode (kept in a non-persisted `lastVisibleSidebarMode`). New keybinding `hide-sidebar`, "Hide Sidebar", `⌘⇧\`, plus a command palette entry.

### 2. `SidebarRail` component

New `src/components/sidebar/SidebarRail/` (`SidebarRail.tsx`, `SidebarRail.module.css`, `RailProjectTile.tsx`, `RailWorkspacePopover.tsx`). It's 52px wide, uses the same `var(--dim)` background and right border as `.sidebar`, and carries `data-focus-region="sidebar"`.

Top to bottom:
1. A 32px drag-region spacer (`-webkit-app-region: drag`) for the traffic lights, matching `.titlebar`.
2. **Home** tile (`House` icon). Clicking it calls `setActiveWorkspace(HOME_PATH)`; it's highlighted when home is active.
3. A divider, then one **project tile** per `buildTopLevelEntries(projects)` entry, in sidebar order, in a scrollable column.
4. A spacer, then **Agents** (`Bot` icon plus a count of the agents `AgentsList` shows; clicking calls the same `onShowAgents` as "View All") and **Notifications** (reuse `<NotificationsPopover />`).

Back/forward and the ports list are not in the rail. Their shortcuts and the full sidebar still reach them.

**Project tile** (`RailProjectTile`), a `<Button>` wrapped in a `<Tooltip>` showing the project or group name:
- 32px rounded square tinted with `projectColorStyle(color)` (`--project-color` mixed into the surface). A group uses the first member with a color, the same rule as `ProjectGroupItem`.
- Label: `railTileLabel(name)` gives a leading emoji if the name starts with one, otherwise the first letter, uppercased.
- Status badge in the bottom-right corner is `<WorkspaceIndicatorDot>` from `toWorkspaceIndicator(...)`, fed by `useProjectAgentStatus(project)` for a project and `useGroupAgentStatus(members)` for a linked group.
- Active marker: a 3px bar on the left edge when the entry holds the selected project and home isn't active, using the same `isSelected` rule `Sidebar.tsx` passes to its items.
- Clicking opens the workspace popover.

**Workspace popover** (`RailWorkspacePopover`), a Radix `Popover` like `PrPopover`, `side="right"`, `align="start"`:
- Heading: the project or group name in its project color.
- Rows come from `railWorkspaceRows(entry)` (below), in sidebar tree order, with hidden workspaces left out. For a linked group, each host section gets a host heading (reuse the ADR-193 host label; export `SectionHostLabel` from `ProjectItem.tsx` or move it next to it). Folder names show as dim sub-headings.
- Each row shows the workspace display name, its `WorkspaceIndicatorDot` (`useWorkspaceAgentStatus(workspaceKey(hostId, ws.path))`), and a selected background when it's the active workspace on the active host.
- Clicking a row calls `selectWorkspace(project.id, project.workspaces.indexOf(ws))` (and `selectProject` like the full sidebar's `onSelect`), then closes the popover.
- The display name comes from a shared `workspaceDisplayName(ws, remoteTarget)` pulled out of the inline logic at `ProjectItem.tsx:706` so the rail and the tree agree.

**Keyboard:** `focus-sidebar` focuses the active tile, or Home. ↑/↓ move between rail buttons (roving tabindex, like `useRovingRows`). Enter or Space opens the popover, and Radix handles focus inside it and Esc.

### 3. Pure helpers in `src/lib/sidebar-rail.ts`

- `railTileLabel(name: string): string`
- `railWorkspaceRows(entry: TopLevelEntry): RailRow[]`, where `RailRow` is one of
  `{ kind: "host"; hostId }`, `{ kind: "folder"; name; depth }` or `{ kind: "workspace"; project; ws }`.
  It flattens `buildSidebarItems` per section and skips hidden workspaces and empty folders. A single-host project gets no host row.

These are unit tested, so the component stays thin.

## Consequences

**Better**
- Collapsing costs about 170px less than the full sidebar and still shows agent status per project, so you see when something needs you without expanding.
- Switching to another workspace takes two clicks without expanding the sidebar or reflowing terminals.
- `sidebarMode` is persisted, so the rail survives a restart. Today's hidden state is not persisted.

**Harder / risks**
- The popover is a second place that lists workspaces. Keeping it on `railWorkspaceRows` plus `workspaceDisplayName` limits drift, but new row features (PR badges, diff stats) won't show up there automatically, which is intended.
- No context menus, drag-to-reorder or multi-select in the rail. Flows that need them (`ensureSidebarVisible`) switch back to `full`.
- Ports and back/forward are only reachable through shortcuts or the full sidebar while in rail mode.
- The traffic-light inset is macOS-shaped, like the existing `.noSidebar` 78px padding. Other platforms get the same (harmless) spacing.
- `⌘\` changes meaning from "hide" to "collapse to rail". Hiding moves to `⌘⇧\`.

## Amendment: the popover is the sidebar entry, opened on hover

After the first build, the popover changed in two ways.

- **Same content as the full sidebar.** The popover now renders the entry through `SidebarEntry` (`src/components/sidebar/SidebarEntry.tsx`), the component the full sidebar uses too. It's `ProjectItem` / `ProjectGroupItem` wired to the stores, pulled out of `Sidebar.tsx`. So the popover has the same rows, branch lines, diff stats, PR badges, host sections, folders, context menus and actions, at the sidebar's width. It's always expanded (`forceExpanded`), whatever the entry's stored collapsed state. `railWorkspaceRows` and the custom popover rows are gone.
- **Hover intent.** Resting the pointer on a tile for 1s opens the popover without taking focus. Leaving the tile and the popover closes it after 300ms. It stays open while a menu or dialog opened from inside is up, or while an inline rename has focus. Clicking the tile, or pressing Enter/Space, opens it right away with focus inside. Switching workspace from it closes it and focuses the new pane.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
