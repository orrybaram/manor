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

# ADR-001: Split electron/main.ts into focused modules

## Context

`electron/main.ts` is ~1,710 lines containing all Electron main-process logic: 90 IPC handlers across 16 logical groups, window management, service initialization, app lifecycle events, and notification logic. Every handler closes over module-level singletons (`mainWindow`, `backend`, `taskManager`, etc.). There is no `electron/ipc/` directory yet.

This monolithic structure makes the file hard to navigate, review, and test. Multiple features touching main-process code cause merge conflicts.

## Decision

Split `electron/main.ts` into focused modules using a dependency-injection pattern:

### Shared infrastructure
- **`electron/ipc/types.ts`** — `IpcDeps` interface that bundles all services handlers need (`mainWindow`, `backend`, `taskManager`, etc.), plus re-exports of shared types like `WorkspaceMeta`
- **`electron/window.ts`** — `createWindow()`, bounds/zoom persistence helpers, `WindowBounds` interface, `boundsAreVisible()`, `manorDataDir()`
- **`electron/notifications.ts`** — `maybeSendNotification()`, `updateDockBadge()`, unseen-task tracking sets

### IPC modules (each exports `register(deps: IpcDeps)`)
- **`electron/ipc/pty.ts`** — `pty:*` handlers (5 handlers)
- **`electron/ipc/layout.ts`** — `layout:*` handlers (3 handlers)
- **`electron/ipc/projects.ts`** — `projects:*` handlers (16 handlers)
- **`electron/ipc/theme.ts`** — `theme:*` handlers (6 handlers)
- **`electron/ipc/ports.ts`** — `ports:*` handlers + `enrichPorts()` (6 handlers)
- **`electron/ipc/branches-diffs.ts`** — `branches:*`, `diffs:*`, `git:*` handlers (10 handlers)
- **`electron/ipc/integrations.ts`** — `github:*`, `linear:*` handlers (23 handlers)
- **`electron/ipc/webview.ts`** — `webview:*` handlers, webview registry, context menu/escape/new-window cleanup maps, `INTERCEPT_NEW_WINDOW_SCRIPT` constant (7 handlers)
- **`electron/ipc/tasks.ts`** — `tasks:*` handlers, `paneContextMap` (6 handlers)
- **`electron/ipc/misc.ts`** — `dialog:*`, `shell:*`, `clipboard:*`, `updater:*`, `preferences:*`, `keybindings:*` handlers (14 handlers)

### App lifecycle
- **`electron/app-lifecycle.ts`** — `initApp()` containing `app.whenReady()` setup, menu construction, service startup sequencing, `agentHookServer.setRelay()` callback (the task lifecycle state machine), and app event handlers (`activate`, `window-all-closed`, `before-quit`)

### Thin entry point
- **`electron/main.ts`** — imports and calls `initApp()`, plus the pre-`whenReady` side effects (PATH fix, dev app name)

### IpcDeps interface shape

```typescript
interface IpcDeps {
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

Using a getter `getMainWindow()` instead of a direct reference because `mainWindow` is created asynchronously in `whenReady` and may be null.

## Consequences

**Benefits:**
- Each module is ~50–250 lines, easy to navigate and review
- Individual IPC groups can be tested in isolation by mocking `IpcDeps`
- Merge conflicts reduced — features touch only their specific IPC module
- Clear dependency graph via explicit `IpcDeps` parameter

**Risks:**
- Circular dependency potential if modules import from each other (mitigated by `IpcDeps` injection)
- The `agentHookServer.setRelay()` callback (~150 lines) is the most complex piece — it stays in `app-lifecycle.ts` since it orchestrates cross-cutting state

**No behavioral changes** — same IPC channel names, same handler signatures, renderer code untouched.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
