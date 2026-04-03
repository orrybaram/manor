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

# ADR-005: Fix workspace persistence on restart

## Context

When the user switches workspaces (especially across projects), the app does not persist which project was last active. The `selectWorkspace` method in `electron/persistence.ts` updates `selectedWorkspaceIndex` for the target project but does not update `selectedProjectIndex` on the global state. On restart, the app uses the stale `selectedProjectIndex`, opening the wrong project/workspace.

The frontend `selectWorkspace` in `project-store.ts` correctly updates `selectedProjectIndex` in local Zustand state, and calls `window.electronAPI.projects.selectWorkspace()` IPC — but the backend handler only persists the workspace index, not the project index.

## Decision

Update `ProjectManager.selectWorkspace()` in `electron/persistence.ts` to also update `this.state.selectedProjectIndex` to the index of the project being selected. This is a one-line fix that ensures the persisted state matches what the frontend already does in memory.

## Consequences

- **Positive**: App restarts will correctly restore the last active project and workspace.
- **Minimal risk**: The change is additive — it persists data that was already being tracked in-memory but not written to disk.
- **No breaking changes**: The persisted JSON format is unchanged; we're just updating an existing field more frequently.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
