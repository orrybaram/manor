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

# ADR-100: Add Context Menu to DiffPane

## Context

The DiffPane component currently has no right-click context menu. Users need the ability to copy selected text and open files in their configured editor directly from the diff view. The TerminalPane already implements a context menu using `@radix-ui/react-context-menu`, and there's an existing `shell.openInEditor` Electron API that opens paths in the user's configured editor (with fallback to `shell.openPath`).

## Decision

Add a Radix UI context menu to each file block in the DiffPane. The menu will have two items:

1. **Copy** — copies the current text selection to clipboard (using `navigator.clipboard.writeText`). Disabled when nothing is selected.
2. **Open in Editor** — calls `window.electronAPI.shell.openInEditor()` with the full file path (workspace path + file's relative path from the diff).

The context menu wraps each `.file` div (not the entire container), so we know which file the user right-clicked on. This follows the same Radix `ContextMenu.Root > Trigger > Portal > Content` pattern used in TerminalPane.

Context menu styles will be added to `DiffPane.module.css`, matching the existing TerminalPane context menu styles (same variables: `--surface`, `--border`, `--accent`, `--text-selected`).

## Consequences

- Users get a familiar right-click workflow for copy and open-in-editor in the diff view.
- Adds `@radix-ui/react-context-menu` as an import to DiffPane (already a project dependency).
- The "Open in Editor" item constructs a full path by joining `workspacePath` with the diff file's relative path, which works because `parseDiff` extracts the `b/` path from `diff --git` lines.
- No changes to Electron main process or preload — both `shell.openInEditor` and clipboard APIs are already available.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
