---
title: Add IPC endpoint, store method, and content type
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add IPC endpoint, store method, and content type

Wire up the full data path: extend pane content type, add IPC for fetching full diff, and add the store method for creating diff sessions.

## Files to touch

- `src/store/pane-tree.ts` — Add `"diff"` to the `contentType` union type on the leaf PaneNode: `contentType?: "terminal" | "browser" | "diff"`

- `electron/diff-watcher.ts` — Add a public `getFullDiff(wsPath: string, defaultBranch: string): Promise<string>` method. It should reuse the same merge-base logic from `getDiffStats` (try `origin/<branch>` then `<branch>`), but run `git diff <mergeBase>` (without `--shortstat`) and return the full unified diff string. Return empty string if no diff.

- `electron/main.ts` — Add IPC handler: `ipcMain.handle("diffs:getFullDiff", (_event, wsPath: string, defaultBranch: string) => diffWatcher.getFullDiff(wsPath, defaultBranch))`

- `electron/preload.ts` — Add to the `diffs` object: `getFullDiff: (wsPath: string, defaultBranch: string) => ipcRenderer.invoke("diffs:getFullDiff", wsPath, defaultBranch)`

- `src/electron.d.ts` — Add type: `getFullDiff: (wsPath: string, defaultBranch: string) => Promise<string>` in the `diffs` interface

- `src/store/app-store.ts` — Add:
  1. `paneDiffPath: Record<string, string>` to `AppState` (maps paneId → workspace path)
  2. Update `paneContentType` type from `Record<string, "terminal" | "browser">` to `Record<string, "terminal" | "browser" | "diff">`
  3. `addDiffSession: (workspacePath: string) => void` method following the `addBrowserSession` pattern:
     - Create a new pane + session with `contentType: "diff"`
     - Set `paneDiffPath[paneId] = workspacePath`
     - Set `paneContentType[paneId] = "diff"`
     - Title should be "Diff"
