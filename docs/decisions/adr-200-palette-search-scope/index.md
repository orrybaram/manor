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

# ADR-200: Project-scoped and global command palette search

## Context

The command palette mixes two kinds of results:

- **Global results**: Go to destinations (Dashboard, Tasks, Projects), app
  commands, settings, navigation.
- **Project-owned results**: workspaces (`useWorkspaceCommands`, one group per
  project), running agents (`useAgentCommands`, each `AgentInfo` has a
  `projectId`), and the Linear / GitHub "Tasks" drill-ins. The drill-ins
  resolve a tracker from `activeProject` in `CommandPalette.tsx`, which is the
  project of the active workspace, falling back to
  `projects[selectedProjectIndex]`.

Today these are scoped inconsistently. Workspaces and agents are always
global. Issue drill-ins always follow the active (or sidebar-selected)
project, even on the Dashboard, where that choice is arbitrary.

The sidebar now has a Search row (`Sidebar.tsx`, `SidebarRail.tsx`,
`onOpenSearch`) that opens the same palette as ⌘K. When someone clicks Search,
or opens the palette from the Dashboard, Tasks or Projects, they expect to
search everything. ⌘K from inside a project workspace should stay focused on
that project. The palette never says which scope it is in.

Mockup (option A approved):
https://claude.ai/artifact/D3xZq4Tw9NFVTNQgAdFnhh

## Decision

### Scope is chosen by where the palette opens

Add a `PaletteOrigin = "shortcut" | "search"` to the palette props
(`types.ts`). App keeps it in state next to `paletteOpen`:

- `togglePalette` (⌘K via `menu-handlers.ts`) and `openPaletteView` open with
  `"shortcut"`.
- `onOpenSearch` on `Sidebar` and `SidebarRail` opens with `"search"`.

A pure helper `resolvePaletteScope({ origin, activeSurface,
activeWorkspacePath, projects })` in `src/components/command-palette/scope.ts`
returns the scoped project id or `null` (global):

- `"search"` → `null`.
- `"shortcut"` → the project that owns `activeWorkspacePath`, but only when
  `activeSurface === "workspace"` and the path is not the home path.
  Otherwise `null`.

The palette resolves the scope once per open (render-time, ref-guarded like
the existing connection check) into `scopeProjectId` state. `handleClose`
resets it.

### What scope filters

When `scopeProjectId` is set:

- Workspace groups: only that project's group.
- Agents: only agents with `agent.projectId === scopeProjectId`. "New Agent"
  and "View All Agents…" stay.
- Linear / GitHub drill-ins: one row each, for the scoped project (current
  behaviour).

When global (`null`):

- Workspace groups: every project (current behaviour).
- Agents: all active agents. Each agent row gets a project tag.
- Linear / GitHub drill-ins: one row per project with a tracker, labelled with
  the project name. Drilling in uses that row's project. `repo` and
  `allTeamIds` derive from a `trackerProjectId` state set on drill-in, instead
  of from `activeProject`.

Go to, app commands, settings, "Run" custom commands and Project Settings do
not change with scope. They act on the current workspace, and widening the
search should never remove what was already there.

### The scope chip

A `ScopeChip` component (`src/components/command-palette/ScopeChip.tsx` plus
module CSS) renders to the left of `Command.Input` in a new input row:

- Scoped: an accent-tinted chip with the project name and a × `Button`
  (`ui/Button`, icon variant, `aria-label="Search all projects"`).
- Global: a neutral "All projects" chip with no ×.
- Only shown on the root view. Issue list, detail, processes and stats views
  keep today's input.

Placeholder: `Search manor…` when scoped, `Search all projects…` when global.

Keyboard, on the root view's input:

- **Backspace** on an empty query while scoped arms the chip (stronger tint).
  A second Backspace widens to global. Any other key disarms.
- **Tab** toggles between the scoped project and global, when the palette was
  opened with a project context (the `resolvePaletteScope` result was
  non-null). Otherwise Tab does nothing special.
- **⌘↵ / Ctrl+↵** widens to global.

### Widening hints

While scoped with a non-empty query, count project-owned items outside the
scope that match (`wordPrefixFilter` against the same `itemValue`):

- If the scoped list is empty and that count is > 0, replace the ghost empty
  state with "No matches in manor. N matches in other projects" plus the ⌫ /
  ⌘↵ hint.
- If the scoped list is not empty, a slim footer shows `+N in other projects
  ⌘↵`. Footer also shows `⌫ clear scope` while scoped.

## Consequences

- ⌘K inside a workspace gets shorter, more relevant results. Other projects'
  workspaces now need one keystroke (⌘↵, Tab or ⌫⌫) to reach. People who used
  ⌘K to jump between projects' workspaces will notice. The footer hint and
  the non-empty-state count are there to soften that.
- The sidebar Search row becomes a real global search. That includes issue
  drill-ins for every project, which also fixes the arbitrary tracker choice
  on the Dashboard.
- `CommandPalette.tsx` grows. The scope logic is kept in `scope.ts`, so the
  rules are unit-testable without rendering cmdk.
- The Frequently Used group is built from `categories`, so it follows scope
  automatically. A frequent workspace from another project disappears while
  scoped. That is intended.
- Tab is taken from focus traversal inside the palette input on the root
  view. The palette has no other focusable targets there, so nothing is lost.
- Detached windows do not render the palette, so they are unaffected.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>

## Implementation notes

- The Projects page was removed while this ADR was in flight (commit
  b78dce39), so "Projects" in the lists above no longer applies. The rules
  are otherwise unchanged.
- Global Linear/GitHub drill-in rows use ids `linear-issues-${projectId}` /
  `github-issues-${projectId}`. The scoped rows keep `linear-issues` /
  `github-issues`, so older Frequently Used history for them only shows up
  in a scoped search.
- The chip's × is `tabIndex={-1}`, because Tab toggles scope. It is still
  clickable.
- `tests/e2e/command-palette-scope.spec.ts` was written without a display to
  run Electron. It has not been run yet.
