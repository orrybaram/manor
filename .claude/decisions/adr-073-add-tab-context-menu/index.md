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

# ADR-073: Add Tab Button Context Menu

## Context

The "add tab" button in the header (`TabBar.tsx`) currently only supports left-click, which creates a new terminal session via `addSession()`. Users who want to create a browser tab or a new task must use keyboard shortcuts (Cmd+Shift+T for browser, Cmd+N for task) or the command palette. There's no discoverable way to create these tab types directly from the add button.

## Decision

Add a right-click context menu to the add tab button using `@radix-ui/react-context-menu` (already a dependency, used in `SessionButton.tsx` and `PortBadge.tsx`). The context menu will show two options:

- **Browser** - Calls `addBrowserSession("about:blank")` (existing store action)
- **Task** - Calls the existing `handleNewTask` flow (creates a session and sends task creation IPC)

Implementation in `TabBar.tsx`:
1. Wrap the existing add button with `ContextMenu.Root` / `ContextMenu.Trigger`
2. Add a `ContextMenu.Portal` with `ContextMenu.Content` containing the two items
3. Reuse the existing `contextMenu` CSS classes from `TabBar.module.css` (already used by `SessionButton`)
4. The left-click behavior (`onClick={addSession}`) remains unchanged

The `TabBar` component needs access to `addBrowserSession` and the new-task handler. `addBrowserSession` is directly available from the store. For the task handler, we'll accept an `onNewTask` callback prop, threaded from `App.tsx` where it's already defined.

## Consequences

- Users get a discoverable way to create browser and task tabs without knowing shortcuts
- No new dependencies needed - uses existing Radix context menu
- Left-click default behavior (new terminal) is preserved
- Minimal code change - single ticket in TabBar.tsx + wiring in App.tsx

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
