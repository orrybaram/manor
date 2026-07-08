---
title: Add pure pane-context resolver module
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Add pure pane-context resolver module

Create a pure, Electron-free, I/O-free module holding the two lookups the `GET /context`
route needs. Everything is handed in as data so it unit-tests without mocking `electron`
or touching the filesystem.

## Contract

```ts
import type { PersistedLayout } from "./terminal-host/layout-persistence";
import type { ProjectInfo, WorkspaceInfo } from "./persistence";

/** The workspacePath whose panes contain `paneId`, or null. */
export function findWorkspaceForPane(
  layout: PersistedLayout,
  paneId: string,
): string | null;

/** The project+workspace whose workspace path best matches `somePath`, or null. */
export function matchProjectByPath(
  projects: ProjectInfo[],
  somePath: string,
): { project: ProjectInfo; workspace: WorkspaceInfo } | null;
```

### `findWorkspaceForPane`

Walk `layout.workspaces[]` → `.panels` (a `Record<string, PersistedPanel>`) →
`.tabs[]` → `.paneSessions` (a `Record<paneId, PersistedPaneSession>`). Return the
enclosing `workspace.workspacePath` when `paneId` is a **key** of `paneSessions`.
Return `null` if not found. Do not look at `daemonSessionId` — the key is the paneId.

Verified shapes (`electron/terminal-host/layout-persistence.ts`):
- `PersistedLayout { version: 2; workspaces: PersistedWorkspace[] }`
- `PersistedWorkspace { workspacePath; panelTree; panels: Record<string, PersistedPanel>; activePanelId }`
- `PersistedPanel { id; tabs: PersistedTab[]; selectedTabId; pinnedTabIds }`
- `PersistedTab { id; title; rootNode; focusedPaneId; paneSessions: Record<string, PersistedPaneSession> }`

Be defensive: `panels`, `tabs`, `paneSessions` may be absent on hand-rolled/legacy files.
Coalesce rather than throw.

### `matchProjectByPath`

Over every `project.workspaces[]`:
- An **exact** `workspace.path === somePath` wins outright.
- Otherwise pick the workspace whose `path` is the **longest prefix** of `somePath`.
  Longest matters: worktrees can live under the main repo path, and the main workspace's
  `path` is a prefix of everything beneath it. Naive "first match" returns the main
  workspace for a worktree.
- Treat a prefix as matching only on a path boundary — `/a/b` must not match `/a/bc`.
  Compare `somePath === p || somePath.startsWith(p + path.sep)`. Import `path` from
  `node:path` (that is not an Electron import; it is fine here).
- Return `null` when nothing matches.

## Files to touch

- `electron/pane-context.ts` — new. The module above. Header comment in the style of
  `electron/control-server.ts`: why it exists, who consumes it (the `GET /context` route).
- `electron/pane-context.test.ts` — new. Colocated Vitest unit tests, matching the
  convention of `electron/issue-sources.test.ts` and `electron/github.test.ts`.

Cover:
- `findWorkspaceForPane` — hit in the first workspace, hit in a later workspace, hit in a
  non-first tab/panel, miss → `null`, and a layout with missing `panels`/`tabs`/
  `paneSessions` keys → `null` rather than a throw.
- `matchProjectByPath` — exact match; **longest-prefix beats a shorter one** (build a
  project whose main workspace is `/repo` and a worktree is `/repo/.worktrees/feat`, then
  resolve `/repo/.worktrees/feat/src` and assert you get the worktree, not main); path
  boundary (`/a/b` must not match `/a/bc`); no match → `null`.

No `vi.mock("electron")` should be needed. If you reach for it, the module is not pure.

## Checks

- `pnpm exec vitest run electron/pane-context.test.ts`
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — repo has ~31 **pre-existing** errors
  unrelated to this ADR. Introduce no new ones; do not fix unrelated files.
- `pnpm exec eslint electron/pane-context.ts electron/pane-context.test.ts`
