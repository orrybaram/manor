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

# ADR-101: Open Diff Pane from Command Palette

## Context

Currently, users can only open a diff pane programmatically via `addDiffSession()`. There is no way to open a diff pane from the command palette. Additionally, if a diff pane already exists in the workspace, opening a new one creates an unnecessary duplicate session.

## Decision

Add an "Open Diff" command to the command palette that:

1. Searches the active workspace's sessions for any pane with `contentType === "diff"` in `paneContentType`
2. If found: switches to that session and focuses the existing diff pane
3. If not found: creates a new diff session via the existing `addDiffSession()` action

Implementation approach:
- Add a new `openOrFocusDiff()` action to `app-store.ts` that encapsulates the find-or-create logic
- Add the command to `useCommands.tsx` with keywords like "git", "changes", "diff"
- Wire it through `CommandPalette.tsx` props

The find logic iterates over all sessions in the active workspace, checks each pane via `allPaneIds()`, and looks up `paneContentType[paneId]` to find a diff pane. This mirrors the pattern in `task-navigation.ts`.

## Consequences

- Users get a discoverable way to open diffs from the command palette
- No duplicate diff sessions - the command reuses existing ones
- Minimal code change: one new store action + one new command item

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
