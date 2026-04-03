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

# ADR-050: Add "Open in Default Editor" Command

## Context

Users want to quickly open a workspace directory in their preferred code editor (e.g., VS Code, Cursor, Zed) from Manor. Currently Manor offers "Open in Finder" in the workspace context menu, but there's no way to open a workspace in an editor without switching to Finder or a terminal first.

On macOS, the system `open` command already resolves the default application for a directory — if the user has set VS Code or another editor as the default handler for folders, `open /path/to/dir` opens it directly. This is the simplest approach that respects user preferences without requiring Manor to maintain its own editor configuration.

## Decision

Add an "Open in Editor" command available in two places:

1. **Command Palette** — "Open in Editor" command that opens the active workspace directory
2. **Sidebar context menu** — "Open in Editor" menu item on each workspace, alongside the existing "Open in Finder"

Implementation:
- Add a new IPC channel `shell:openPath` in `electron/main.ts` that calls Electron's `shell.openPath(path)` — this uses the OS default handler for the path
- Expose it via `electron/preload.ts` as `window.electronAPI.shell.openPath`
- Add the type to `src/electron.d.ts`
- Add command to `useCommands.tsx` reading `activeWorkspacePath` from the app store
- Add context menu item to `ProjectItem.tsx`

Using `shell.openPath` (Electron built-in) is cleaner than spawning `open` as a child process and works cross-platform.

## Consequences

- Users can open workspaces in their default editor with one command
- Relies on OS-level default app association — no Manor-specific editor config needed
- If the user hasn't set a default editor for directories, macOS will use Finder (same as current "Open in Finder" behavior) — this is acceptable as a fallback

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
