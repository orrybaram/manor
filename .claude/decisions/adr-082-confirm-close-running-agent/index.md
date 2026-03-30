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

# ADR-082: Confirmation Dialog When Closing Pane With Running Agent

## Context

Panes with active agent sessions (status: `thinking`, `working`, or `requires_input`) can be closed without any warning — via the close button in the pane status bar or the Cmd+W keyboard shortcut. This risks accidentally terminating in-progress agent work.

The app already has a well-established confirmation dialog pattern using `@radix-ui/react-dialog` with shared CSS classes from `Sidebar.module.css` (e.g., `RemoveProjectDialog`, `DeleteWorktreeDialog`).

## Decision

Add a confirmation dialog that intercepts pane close when the pane has an active agent. The implementation touches three files:

1. **New component `CloseAgentPaneDialog.tsx`** — A simple Radix dialog following the `RemoveProjectDialog` pattern. Shows a warning message and Cancel/Close buttons.

2. **`LeafPane.tsx`** — Add state for the dialog. In `handleClose`, check `paneAgentStatus[paneId]` — if status is `thinking`, `working`, or `requires_input`, show the dialog instead of closing immediately. On confirm, proceed with close.

3. **`App.tsx`** — For the Cmd+W keybinding path, move the agent-active check into the store's `closePane()` method by having it return a boolean indicating whether the close was blocked. If blocked, App.tsx can trigger a confirmation. Alternatively, the simpler approach: since `closePane()` just delegates to `closePaneById()` for the focused pane, and LeafPane already handles its own close button, we need to handle the keyboard shortcut path too.

   The cleanest approach: add a `pendingCloseConfirmPaneId` field to the store. Both `handleClose` in LeafPane and the Cmd+W handler in App.tsx call a new `requestClosePane()` method that either closes immediately or sets `pendingCloseConfirmPaneId`. The `CloseAgentPaneDialog` is rendered once in App.tsx, reads this store field, and on confirm calls `closePaneById()`.

Active agent statuses (worth confirming): `thinking`, `working`, `requires_input`. Non-active statuses (`idle`, `complete`, `error`) close immediately without confirmation.

## Consequences

- **Better**: Prevents accidental termination of running agents
- **Better**: Consistent UX pattern with existing confirmation dialogs
- **Tradeoff**: Adds one extra click when intentionally closing a pane with a running agent
- **Risk**: Minimal — follows established patterns, small surface area

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
