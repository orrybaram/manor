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

# ADR-143: Visually hide/unhide workspaces

## Context

Projects accumulate worktree workspaces that linger — long-running branches the
user no longer actively cares about but isn't ready to delete (the worktree is
still on disk, may have running terminals/agents, or an open PR). These clutter
the sidebar workspace list under each project.

The user wants to **visually hide** such workspaces to declutter the sidebar,
and **unhide** them later. This is purely cosmetic: a hidden workspace keeps its
worktree on disk, its panes/terminals keep running, and its agent activity still
feeds the project's aggregate agent dot on the collapsed project header. Hiding
never deletes anything and is fully reversible.

The codebase already has a clean precedent for per-workspace metadata that
overlays the git-discovered workspace list: **`workspaceNames`** (rename) and
`workspaceOrder` (drag-reorder), both stored as `Record<string, …>` keyed by
workspace path on `PersistedProject` in `~/.manor/projects.json`, applied in
`ProjectManager.buildProjectInfo`. We mirror that pattern exactly.

## Decision

Add a per-workspace boolean **`hidden`** flag, persisted as
`workspaceHidden?: Record<string, boolean>` on `PersistedProject`, mirroring the
`workspaceNames` rename pattern end-to-end through the existing layers:

**Persistence (`electron/persistence.ts`)**
- Add `hidden?: boolean` to the backend `WorkspaceInfo` interface.
- Add `workspaceHidden?: Record<string, boolean>` to `PersistedProject`.
- New method `setWorkspaceHidden(projectId, workspacePath, hidden)` — sets/deletes
  the map entry and `saveState()`, exactly like `renameWorkspace`.
- In `buildProjectInfo`, populate `hidden: hiddenMap[ws.path] ?? false`.

**IPC / bridge (`electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`)**
- New handler `projects:setWorkspaceHidden`, preload method
  `projects.setWorkspaceHidden(projectId, workspacePath, hidden)`, and matching
  type in `electron.d.ts`, all paralleling `renameWorkspace`.

**Frontend store (`src/store/project-store.ts`)**
- Add `hidden?: boolean` to the frontend `WorkspaceInfo`.
- New action `setWorkspaceHidden(projectId, workspacePath, hidden)` that calls the
  IPC method then reloads projects, like `renameWorkspace`.

**Sidebar UI (`src/components/sidebar/ProjectItem.tsx`, `Sidebar/Sidebar.tsx`)**
- In the workspace render loop, **skip hidden workspaces** (`if (ws.hidden) return
  null`) — keep iterating over the full `project.workspaces` array so `idx`,
  `selectedWorkspaceIndex`, drag refs, and `workspaceOrder` semantics are
  unchanged.
- Add a plain (non-danger) **`Hide Workspace`** item to the worktree-only section
  of the workspace context menu, next to Rename. Worktrees only — never shown for
  `ws.isMain`.
- **Auto-switch on hide:** if the workspace being hidden is the currently selected
  one, switch the project's selection to its main/local workspace before/after
  hiding so the panes never show a workspace that's no longer in the list.
- Add a **`Hidden workspaces (N) ▸`** submenu to the project header context menu,
  rendered only when N≥1, placed after "Project Settings" and before the
  "Remove Project" danger separator. Each entry is a hidden worktree's display
  name; selecting it unhides (`setWorkspaceHidden(…, false)`).

No sidebar indicator (the count lives only in the context-menu submenu label).

## Consequences

- **Better:** sidebar declutters without destroying worktrees; fully reversible;
  reuses an established, low-risk metadata-overlay pattern (no schema migration —
  absent map ⇒ nothing hidden).
- **Trade-off / risk:** hidden workspaces have no sidebar footprint, so they're
  only rediscoverable via the project context menu (count shown there mitigates
  the "black hole" risk). A hidden worktree's agent still runs and feeds the
  aggregate project dot, but its individual status is not visible until unhidden —
  acceptable per the agreed "stays hidden regardless of agent activity" model.
- **Stale entries:** like `workspaceNames`, a `workspaceHidden` entry for a
  deleted worktree is harmless dead data.
- **Index care:** rendering must skip-in-place (return null) rather than filter
  the array, to preserve the index-based selection/drag contract; called out
  explicitly in the UI ticket.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
