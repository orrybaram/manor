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

# ADR-026: Add Cmd+N shortcut for New Task

## Context

Creating a new task in the current workspace requires opening the command palette (Cmd+K) and selecting "New Task". A dedicated Cmd+N shortcut would make this faster and more discoverable. The shortcut visual should also appear in the command palette next to the "New Task" command.

## Decision

Add Cmd+N as a global keyboard shortcut that triggers `handleNewTask` in App.tsx. Three files need changes:

1. **`src/App.tsx`** — Add `e.key === "n"` handler in `handleKeyDown` that calls `handleNewTask()`
2. **`src/hooks/useTerminalHotkeys.ts`** — Add `"n": true` to `APP_SHORTCUTS` so xterm doesn't swallow the key
3. **`src/components/CommandPalette/useTaskCommands.tsx`** — Add `shortcut: "⌘N"` to the "New Task" command item

## Consequences

- Users get a faster path to creating tasks
- Consistent with macOS conventions (Cmd+N for "new")
- Cmd+N will no longer be available for terminal use (acceptable tradeoff since Cmd+T already creates raw sessions)
