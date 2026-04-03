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

# ADR-069: Add Cmd+Shift+N shortcut to create new workspace

## Context

Creating a new workspace currently requires navigating through the command palette or sidebar context menus. A direct keyboard shortcut would make this faster and more discoverable.

## Decision

Add a `new-workspace` keybinding (`Cmd+Shift+N`) to the existing keybinding system. This requires two changes:

1. **`src/lib/keybindings.ts`** — Add a `new-workspace` entry to `DEFAULT_KEYBINDINGS` with `metaCombo("n", true)` (Cmd+Shift+N), category `"workspace"`.
2. **`src/App.tsx`** — Add a `"new-workspace"` handler to `handlersRef.current` that calls `setNewWorkspaceOpen(true)`.

No conflict exists — `Cmd+N` is already "New Task" and `Cmd+Shift+N` is unused. The shortcut will automatically appear in the command palette's keybinding hints since it uses the same registry.

## Consequences

- Users get a direct shortcut to create workspaces without navigating menus.
- The shortcut is discoverable via the keybindings settings and command palette.
- No existing shortcuts are affected.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
