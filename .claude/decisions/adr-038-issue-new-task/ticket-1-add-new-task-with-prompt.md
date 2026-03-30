---
title: Add onNewTaskWithPrompt callback and wire through all layers
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add onNewTaskWithPrompt callback and wire through all layers

Implement the full feature in a single pass: types, App handler, CommandPalette threading, both issue detail views, and footer hints.

## Files to touch

- `src/components/CommandPalette/types.ts` — Add `onNewTaskWithPrompt?: (prompt: string) => void` to `CommandPaletteProps`
- `src/App.tsx` — Create `handleNewTaskWithPrompt` callback (like `handleNewTask` but with prompt escaping from the workspace flow). Pass it to `<CommandPalette>`.
- `src/components/CommandPalette/CommandPalette.tsx` — Accept and forward `onNewTaskWithPrompt` to `IssueDetailView` and `GitHubIssueDetailView`.
- `src/components/CommandPalette/IssueDetailView.tsx` — Accept `onNewTaskWithPrompt` prop. Add `handleNewTask` that builds prompt from issue title+description, calls `onNewTaskWithPrompt`, calls `linear.startIssue`, and closes palette. Add `Shift+Enter` keyboard handler. Add footer hint `<kbd>Shift+Enter</kbd> New Task`.
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — Same pattern: accept prop, add handler (calls `github.assignIssue` too), add `Shift+Enter` keyboard handler, add footer hint.
