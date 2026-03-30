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

# ADR-085: Git Diff Viewer Pane

## Context

The sidebar already shows diff stats (+N / -N) per workspace, but there's no way to actually view the diffs. Users want to click that indicator and see the full unified diff between their branch and main, including uncommitted changes. This should open as a new session tab (same system as terminals and browser tabs).

## Decision

Add a new `"diff"` content type to the pane system, following the existing pattern used by `"browser"` tabs.

### Architecture

**New content type**: Extend `PaneNode.contentType` to `"terminal" | "browser" | "diff"`.

**Library**: Use `diff2html` for rendering unified diffs with syntax highlighting (GitHub-style). It's lightweight, well-maintained, and produces styled HTML from raw unified diff output. Use `diff2html/bundles/css/diff2html.min.css` for styles.

**Data flow**:
1. Click diff indicator on `WorkspaceItem` in sidebar
2. Call new `addDiffSession(workspacePath)` on `useAppStore`
3. This creates a session with `contentType: "diff"` and stores the workspace path in `paneDiffPath`
4. `LeafPane` routes to new `DiffPane` component
5. `DiffPane` calls a new IPC method `diffs:getFullDiff` which runs `git diff <merge-base>` in the main process
6. The raw unified diff string is passed to `diff2html` and rendered as highlighted HTML

**IPC addition**: Add `diffs:getFullDiff(workspacePath: string, defaultBranch: string)` to the electron main process. It reuses the same merge-base logic from `DiffWatcher.getDiffStats()` but returns the full diff output instead of `--shortstat`.

**Entry point**: Make the diff stats span in `WorkspaceItem` clickable. On click, call `addDiffSession` with the workspace path.

### Files

| File | Change |
|------|--------|
| `src/store/pane-tree.ts` | Add `"diff"` to `contentType` union |
| `src/store/app-store.ts` | Add `paneDiffPath: Record<string, string>`, `addDiffSession()` method, update `paneContentType` type |
| `src/components/DiffPane.tsx` | New — renders diff2html output, calls IPC to get diff |
| `src/components/DiffPane.module.css` | New — container styles, scroll, diff2html overrides |
| `src/components/LeafPane.tsx` | Add `"diff"` branch to content type routing |
| `src/components/SessionButton.tsx` | Show `GitCompareArrows` icon for diff tabs |
| `src/components/useSessionTitle.ts` | Return "Diff" title for diff panes |
| `src/components/ProjectItem.tsx` | Add click handler on diff stats to open diff session |
| `src/electron.d.ts` | Add `diffs.getFullDiff()` type |
| `electron/preload.ts` | Expose `diffs.getFullDiff` IPC |
| `electron/main.ts` | Handle `diffs:getFullDiff` IPC |
| `electron/diff-watcher.ts` | Extract shared merge-base logic, add `getFullDiff()` method |

## Consequences

- **Positive**: Users can view all branch changes from within the app. Leverages existing tab infrastructure — minimal new patterns.
- **Positive**: `diff2html` handles syntax highlighting out of the box, no need to build a custom renderer.
- **Negative**: Adds `diff2html` as a new dependency (~80KB gzipped).
- **Risk**: Very large diffs could be slow to render. Acceptable for MVP — can add file-level collapsing later.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
