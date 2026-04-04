---
title: Extract shared types, window management, and notifications
status: in-progress
priority: critical
assignee: sonnet
blocked_by: []
---

# Extract shared types, window management, and notifications

Create the foundational modules that other tickets depend on.

## 1. `electron/ipc/types.ts` — IpcDeps interface

Create the `electron/ipc/` directory and `types.ts`. Define:

```typescript
export interface IpcDeps {
  getMainWindow: () => BrowserWindow | null;
  backend: LocalBackend;
  layoutPersistence: LayoutPersistence;
  projectManager: ProjectManager;
  themeManager: ThemeManager;
  portScanner: PortScanner;
  branchWatcher: BranchWatcher;
  diffWatcher: DiffWatcher;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  taskManager: TaskManager;
  preferencesManager: PreferencesManager;
  keybindingsManager: KeybindingsManager;
  workspaceMeta: WorkspaceMeta[];
  paneContextMap: Map<string, { projectId: string; projectName: string; workspacePath: string }>;
}
```

Also move and re-export `WorkspaceMeta` interface (lines 50–55 of main.ts) here.

## 2. `electron/window.ts` — Window management

Move from `electron/main.ts`:
- `WindowBounds` interface (lines 61–67)
- `manorDataDir()` (lines 99–103)
- `windowBoundsPath()` (lines 105–107)
- `zoomLevelPath()` (lines 109–111)
- `loadZoomLevel()` (lines 113–120)
- `saveZoomLevel(factor)` (lines 122–130)
- `loadWindowBounds()` (lines 132–138)
- `saveWindowBounds(win)` (lines 141–153)
- `boundsAreVisible(bounds)` (lines 155–164)
- `createWindow()` (lines 166–229)

Export `createWindow`, `saveZoomLevel`, `loadZoomLevel`, `manorDataDir`, and any other functions needed by other modules.

`createWindow` uses `screen` from electron, `fs`, `path`, `os` — import these directly in window.ts.

## 3. `electron/notifications.ts` — Notification logic

Move from `electron/main.ts`:
- `updateDockBadge()` (lines 255–267) — needs `app`, `unseenRespondedTasks`, `unseenInputTasks`
- `maybeSendNotification(task, prevStatus, newStatus)` (lines 1310–1353) — needs `mainWindow`, `preferencesManager`, `Notification`, `execFile`

These functions need access to `unseenRespondedTasks` (line 252) and `unseenInputTasks` (line 253) sets. Export these sets from this module, or accept them as parameters.

Preferred approach: export a `NotificationManager` or just export the functions + the two Sets so app-lifecycle.ts can import and use them.

## 4. Update `electron/main.ts`

After extracting, replace the moved code in main.ts with imports from the new modules. The moved code should be deleted from main.ts and replaced with:

```typescript
import { createWindow, saveZoomLevel, loadZoomLevel, manorDataDir, WindowBounds } from './window';
import { maybeSendNotification, updateDockBadge, unseenRespondedTasks, unseenInputTasks } from './notifications';
import { IpcDeps, WorkspaceMeta } from './ipc/types';
```

Keep all IPC handlers in main.ts for now — later tickets will extract them.

## Files to touch
- `electron/ipc/types.ts` — CREATE: IpcDeps interface, WorkspaceMeta
- `electron/window.ts` — CREATE: window management functions
- `electron/notifications.ts` — CREATE: notification functions
- `electron/main.ts` — MODIFY: remove extracted code, add imports
