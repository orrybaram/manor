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

# ADR-203: One workspace operations module under IPC and the control routes

## Context

Creating, removing and quick-merging a workspace each have two transport adapters in
main — the IPC handlers in `electron/ipc/projects.ts` (the UI) and the HTTP control routes in
`electron/routes/projects.ts` (the `manor` CLI and MCP). Each adapter wraps the
`ProjectManager` call with its own choice of side effects:

| Side effect                         | IPC (UI)                                     | Route (CLI / MCP)                    |
| ----------------------------------- | -------------------------------------------- | ------------------------------------ |
| `pm.createWorktree`                 | ✓                                            | ✓                                    |
| stats `worktreesCreated`            | ✓                                            | ✗                                    |
| group last-used host                | renderer (`project-store.ts:1014`, over IPC) | ✓ `recordLastUsedHost`               |
| `notifyProjectsChanged`             | — (renderer sets state itself)               | ✓                                    |
| setup script                        | renderer (`startSetupScript`, with the setup view and optional agent) | ✓ `runSetupScript` bridge |
| stats `worktreesRemoved` (remove)   | ✓                                            | ✗                                    |
| stats `worktreesMerged` (quick merge) | ✓                                          | ✗                                    |
| batch create from issues            | no IPC                                       | last-used host + broadcast, no stats |

User-visible bug: workspaces that agents create, remove or merge through the CLI or MCP never
reach stats or badges (`stats-badges.ts` reads `worktreesCreated`/`Removed`/`Merged`).
Understanding one operation means reading three modules across two processes, and each new
side effect has to be remembered twice.

### Audit of the other IPC ↔ route pairs

The remaining writes that exist on both sides — `convertMainToWorktree`, `renameWorkspace`,
`setWorkspaceHidden`, `reorderWorkspaces`, `updateProject`, `removeProject`,
`reorderProjects`, `addProject` — differ only in `notifyProjectsChanged`: the route broadcasts
because the renderer never saw the write; the IPC path skips it because the renderer updates its
own store. That difference is a transport concern, not drift, so they stay as they are.

## Decision

### 1. `electron/workspace-ops.ts` — a deep module for the workspace lifecycle

```ts
export interface WorkspaceOpsDeps {
  projectManager: Pick<ProjectManager,
    "createWorktree" | "createWorkspacesFromIssues" | "removeWorktree" |
    "quickMergeWorktree" | "setGroupLastUsedHost">;
  statsStore: Pick<StatsStore, "record">;
  /** The renderer bridge (`renderer-bridge.ts`), injected so tests need no `vi.mock("electron")`. */
  notifyProjectsChanged: () => void;
  runSetupScript: (workspacePath: string, script: string, hostId: HostId) => void;
}

export interface WorkspaceOps {
  create(req: CreateWorkspaceRequest, opts: { runSetupScript: boolean }):
    Promise<{ project: ProjectInfo | null; workspacePath: string | null }>;
  createFromIssues(projectId: string, seeds: IssueSeed[], baseBranch?: string):
    Promise<WorkspaceFromIssue[]>;
  remove(projectId: string, worktreePath: string, deleteBranch?: boolean,
    onProgress?: (step: string) => void): Promise<void>;
  quickMerge(projectId: string, worktreePath: string): Promise<void>;
}

export function createWorkspaceOps(deps: WorkspaceOpsDeps): WorkspaceOps;
```

Each method runs the whole operation, in this order:

- **create** — `pm.createWorktree`; if it returned a project: stats `worktreesCreated`, record
  the project's host as its group's last-used host (logged, never thrown — moved here from the
  route's `recordLastUsedHost`); then `notifyProjectsChanged()` (always, as the route does
  today); then, when `opts.runSetupScript` and the project has a `worktreeStartScript`, the
  setup script via the bridge. The created workspace is found by the renderer's existing rule
  (non-main, `name === req.name` or `branchesEqual(branch, req.branch || req.name)`), so no
  "before" snapshot is needed and IPC can call it with just a project id.
- **createFromIssues** — `pm.createWorkspacesFromIssues`; stats `worktreesCreated` by the number
  actually created; last-used host if any were created; broadcast. (Setup scripts stay unrun for
  batch creates, as today — changing that is out of scope.)
- **remove** — `pm.removeWorktree` (with `onProgress`); stats `worktreesRemoved`; broadcast.
- **quickMerge** — `pm.quickMergeWorktree`; stats `worktreesMerged`; broadcast.

A throw from the manager propagates and records nothing (the current IPC behaviour). The
last-used host needs the group, which `pm.createWorktree`'s returned `ProjectInfo` carries, so
the module never re-reads the project list.

**Setup script ownership.** The UI path keeps running the script in the renderer: its
`createWorktree` drives the pending setup view and may launch an agent alongside the script, and a
main-initiated `run-setup-script` would race the `__pending__` → path migration and run the script
twice. So IPC passes `runSetupScript: false` and the routes pass `true`. This is the one
transport-chosen knob, and it is explicit at the call site instead of implicit in which side
effects each adapter remembered.

### 2. One instance, on both dependency bags (extends ADR-171 §1)

`app-lifecycle.ts` builds one `WorkspaceOps` from `projectManager`, `statsStore`, and
`notifyProjectsChanged` / `runSetupScript` from `renderer-bridge.ts`, and passes it on `ipcDeps`
(`IpcDeps.workspaceOps: WorkspaceOps`) and to `webviewServer.setControlDeps`
(`ControlDeps.workspaceOps: WorkspaceOps | null`, nullable like every other field).

### 3. Thin adapters

- `ipc/projects.ts`: `projects:createWorktree` → `ops.create(…, { runSetupScript: false })`,
  returning `.project` (IPC return shape unchanged); `removeWorktree` / `quickMergeWorktree` →
  `ops.remove` / `ops.quickMerge`. No `statsStore` use remains in the file.
- `routes/projects.ts`: `POST /workspaces`, `POST /workspaces/batch`, `DELETE /workspaces`,
  `POST /workspaces/quick-merge` validate input, resolve the target host (unchanged), and call
  the ops. `recordLastUsedHost` and the route's direct `notifyProjectsChanged` / `runSetupScript`
  calls for these four routes are deleted. A null `workspaceOps` answers 503 like a missing
  `projectManager`.

### 4. Renderer: drop the duplicate last-used-host write

`src/store/project-store.ts` `createWorktree` stops calling `setGroupLastUsedHost` (lines
~1012-1014): main records it, and the `projects-changed` broadcast the op now sends reloads the
group snapshot. `removeWorktree` / `quickMergeWorktree` in the store are unchanged (their own
`getAll` refresh keeps the awaited action's result current). The store's `setGroupLastUsedHost`
action itself stays — other callers may use it.

### 5. Tests: replace, don't layer

- New `electron/workspace-ops.test.ts`: one `describe` per operation asserting every side effect
  (manager call args, stats counter and count, last-used host incl. ungrouped / failure-logged,
  broadcast, setup script on/off / no script / created workspace found) plus "manager throws →
  nothing recorded". Plain object fakes, no `vi.mock`.
- Delete `electron/__tests__/projects-worktree-stats.test.ts` (IPC stats half-coverage).
- `electron/routes/projects.test.ts`: keep the host-targeting tests (route logic), drive them
  through a fake `workspaceOps`; delete the last-used-host tests now covered by the ops suite.

## Consequences

- **Fixes** CLI/MCP creates, batch creates, removes and merges missing from stats and badges.
- **Locality**: one file says what "create a workspace" does; a new side effect is added once.
- **UI path gains one `projects-changed` broadcast** per create/remove/merge, i.e. one extra
  `loadProjects()` in the renderer. Cheap, and it is what now refreshes the group's last-used host
  after a UI create.
- **Small behaviour change**: IPC create no longer counts `worktreesCreated` when the manager
  returns `null` (project not found — nothing was created).
- **Setup script** remains transport-chosen via an explicit flag; merging the renderer's setup
  view flow into main is a separate, UI-heavy change.
- `app-lifecycle.ts`, `ipc/types.ts` and `routes/types.ts` get a one-field touch each, outside the
  three files named in the task — unavoidable to share one instance.
- ADR number may collide with sibling workspaces' ADRs on merge; renumber then if needed.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
