---
title: Add open-in-editor IPC channel and UI integration
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add open-in-editor IPC channel and UI integration

Add the full "Open in Editor" feature: IPC handler, preload bridge, type declaration, command palette command, and sidebar context menu item.

## Files to touch

- `electron/main.ts` — Add `shell:openPath` IPC handler using Electron's `shell.openPath()`. Validate the path is a string and exists as a directory. Place it next to the existing `shell:openExternal` handler.
- `electron/preload.ts` — Expose `shell.openPath` in the `shell` section, calling `ipcRenderer.invoke("shell:openPath", path)`.
- `src/electron.d.ts` — Add `openPath: (path: string) => Promise<void>` to the `shell` interface in `ElectronAPI`.
- `src/components/CommandPalette/useCommands.tsx` — Add an "open-in-editor" command that reads `activeWorkspacePath` from `useAppStore` and calls `window.electronAPI.shell.openPath(path)`. No keyboard shortcut needed initially.
- `src/components/ProjectItem.tsx` — Add an "Open in Editor" context menu item right after "Open in Finder", calling `window.electronAPI.shell.openPath(ws.path)`.
