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

# ADR-197: Home becomes a tab-less Dashboard

## Context

Home (sentinel workspace path `HOME_PATH = "__home__"`) started life as the
ADR-153 orchestrator surface and was later renamed to Home, given a real cwd
(`~/.manor/home`) and a configurable "home harness" (`homeHarness` /
`homeCustomCommand` / `homeCustomInterrupt`). It behaves like a workspace: it
keeps a persisted `WorkspaceLayout`, and ⌘T / ⌘N / splits / palette / menu /
control-server / MCP can all open terminals, browsers, diffs and agents in it.
ADR-194 then gave Home's *empty* state a dashboard (Needs you, Up next, summary)
under three launchers: New Agent, Open Terminal, Command Palette.

The dashboard is now the point of Home. Agents launched in Home have no
project, no worktree and are excluded from the dashboard's own ranking; tabs
opened there hide the dashboard. Home should be a read-only Dashboard surface
— closer to the ADR-194 Projects overview than to a workspace.

No code path guards Home today: every store action that creates a tab or split
resolves through `getActivePanelContext` / `getActiveLayoutContext`
(`src/store/app-store.ts`) with no Home check, and `start-agent` in
`src/lib/app-commands.ts` has an explicit Home *bypass*.

## Decision

1. **Home never holds tabs.** `getActivePanelContext` and
   `getActiveLayoutContext` return `null` when the active workspace is Home, so
   every store-level creation path (`addTab`, `addTerminalTab`,
   `addBrowserTab`, `addDiffTab`, splits, `duplicateTab`, `reopenClosedPane`,
   `openOrFocusDiff`, …) becomes a no-op there in one place.
   `setActiveWorkspace(HOME_PATH)` stops creating/persisting a layout for Home.
   `receiveReattachedTab` on Home refuses the drop (the source window keeps the
   tab).
2. **Migration.** `loadPersistedLayout` drops any persisted `__home__` layout
   entry and closes its pane sessions (same teardown as closing a pane), so
   existing Home terminals/agents are ended on first launch after upgrade.
   Main's `LayoutPersistence` also drops the entry. Resuming a historical agent
   whose `workspacePath` is Home is refused with a toast.
3. **Entry points hidden/disabled on Home.** Keybindings (`new-tab`,
   `new-agent`, `new-browser`, splits, `reopen-pane`, `open-diff`) are guarded
   like `unlessOverviewShown`. Palette tab/split/agent commands are hidden when
   Home is active; issue-detail "New Agent" is hidden on Home. `MenuContext`
   gains `canCreateTabs` (false on Home / no surface) and the native menu
   disables New Agent / Tab / Browser / Open Diff / Reopen Closed Pane / pane
   items with it. PortBadge "open in tab" is hidden on Home.
4. **Home harness is deleted.** Preference fields (renderer + electron),
   `resolveHomeAdapter` / `HomeHarnessPreferences`, `homeLaunchCommand`, the
   Home branches of `getAgentCommand`, `resolveWorkspaceCommand`,
   `useTerminalLifecycle` and `agent-context-repair`, `HomeSettingsPage`, its
   Settings nav/search entry and the "Settings: Home" palette command, and the
   Home prewarm in `App.tsx`. `adapterForKind`, the adapters and
   `escapeShellDoubleQuoted` stay (used elsewhere). Stale preference keys are
   ignored on load.
5. **Main process rejects Home.** `resolveSpawnCwd` no longer maps
   `__home__`; `validatePtyArgs` rejects it. `homeWorkspaceDir()` and the
   `~/.manor/home` `mkdirSync` at startup are removed (the directory is left on
   disk; we don't delete user files). Control-server commands `new-tab`,
   `split-pane`, `duplicate-tab`, `open-diff`, `start-agent` reject a Home
   target with a clear error ("The Dashboard can't host panes"); MCP/CLI tools
   inherit that. `set-active-workspace` to Home stays allowed.
6. **UI rename, internals unchanged.** User-visible "Home" becomes
   "Dashboard": sidebar row, rail tooltip/aria-label, status bar segment,
   View › Home menu item. The page renders `HomeDashboard` via
   `EmptyStateShell` with no action rows (actions become optional). Internal
   identifiers (`HOME_PATH`, `isHomePath`, `HomeDashboard`, test ids, file
   names, the `"home"` menu command id) stay, so no persisted-key migration is
   needed beyond (2).

## Consequences

- Home stops being a second-class workspace; ~20 `isHomePath` launch branches
  collapse, and the dashboard is always visible on Home.
- **Breaking for users with running Home agents/terminals:** they are closed
  on upgrade. Home agents in history can't be resumed. Users who relied on a
  project-less scratch terminal lose it; the nearest replacement is a
  project workspace.
- ⌘T / ⌘N on the Dashboard do nothing (same as the Projects overview's
  guard) rather than jumping elsewhere — predictable, but may feel inert.
- MCP/CLI callers that targeted `__home__` (or whose caller pane lived in
  Home) now get an error instead of a pane.
- Risk: a missed creation path could still open a tab on Home. The central
  guard in `getActivePanelContext` / `getActiveLayoutContext` limits this to
  code that builds layouts directly; tickets add tests at that seam.
- Mismatch between the "Dashboard" label and internal `home` names is
  accepted to keep the diff small.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
