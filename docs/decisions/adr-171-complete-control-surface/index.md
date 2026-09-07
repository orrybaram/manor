---
type: adr
status: proposed
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

# ADR-171: Complete the Manor control surface

## Context

ADR-170 made the `manor` CLI a generated view of the MCP `ToolModule`s, so every
operation reachable over the control server (`electron/routes/*`, `electron/webview-server.ts`)
is one `ToolDef` away from being a subcommand. The gap is now on the other side: the control
server exposes 35 operations, while the app itself has roughly 120. Everything below already
has a main-process implementation and is only missing a route and a tool definition:

| Area | Exposed | Missing (examples) |
|---|---|---|
| Projects / workspaces / folders | 7 | create/rename/delete folder, move workspace into a folder, rename/hide/reorder workspace, update project, remove project, convert-main-to-worktree, quick-merge, link/unlink issue, list branches |
| Tabs / panes | 6 | select/close/pin/duplicate/reorder tabs, set pane title, move/extract pane, reopen closed pane, open diff tab, set active workspace, webview zoom/find/mute/stop |
| Agents / sessions | 7 | rename/delete/mark-seen agent, resume command, and tools for the two orphan routes `/sessions/interrupt` and `/sessions/end` |
| Git | 0 | stage, unstage, discard, stash, commit, push, staged files, local/full diff |
| Integrations | 2 | Linear start/close issue, GitHub status/create issue |
| System | 0 | notifications, processes, ports, preferences, theme, stats, remote control, open-in-editor, windows, updater |

Three structural facts shape the approach:

1. **`ControlDeps` is a hand-picked six-field subset of `IpcDeps`** (`electron/routes/types.ts`
   vs `electron/ipc/types.ts`). Routes cannot reach `notificationStore`, `preferencesManager`,
   `themeManager`, `statsStore`, `portScanner`, or `remoteControl` today, and `WebviewServer`
   takes them as six positional constructor args.
2. **Renderer-owned state goes through the app-command bridge** (`requestRenderer` /
   `proxyToRenderer` in `electron/renderer-bridge.ts`, dispatch table `appCommandHandlers` in
   `src/lib/app-commands.ts`). Tabs and panes already use it; the pattern extends to every
   `app-store` action with no new plumbing.
3. **A few IPC handlers carry real logic inline** (`processes:list`, `processes:killAll`,
   `shell:openInEditor`, the notification re-broadcast). Routes must not duplicate that; it
   has to move to a shared function both callers use.

## Decision

Expose the full surface in six slices, each a route module plus tool definitions, all
following the conventions ADR-145/149/150 established. No new abstractions beyond widening
the dependency bag and extracting the inline IPC logic.

### 1. One dependency bag

`ControlDeps` grows to the managers the new routes need: `notificationStore`, `statsStore`,
`preferencesManager`, `themeManager`, `portScanner`, `remoteControl`, `agentHookServer`,
`mainWindow` accessor (`getRendererWindows`). `WebviewServer` gains `setControlDeps(deps)`;
`app-lifecycle.ts` calls it once, right after `ipcDeps` is assembled, passing the same objects.
The six positional constructor args stay for now (callers unchanged) but become the fallback
the setter overrides. Every field stays nullable so unit tests can construct a server with none.

Inline IPC logic moves to plain functions: `electron/process-control.ts`
(`listProcesses`, `cleanupDeadProcesses`, `killDaemon`, `killAllProcesses`, `restartPortless`)
and `openInEditor(preferencesManager, dirPath)` in `electron/editor.ts`. `electron/ipc/processes.ts`
and `electron/ipc/misc.ts` become thin callers. Notification mutations over HTTP re-broadcast
through the existing `sendNotificationsUpdate` single send-site.

### 2. Routes

The router supports `GET | POST | DELETE`; verbs that do not fit map to `POST <resource>/<verb>`
rather than adding `PATCH`. Mutating project routes call `notifyProjectsChanged()` exactly as
the existing workspace routes do. Renderer-state routes are one-line `proxyToRenderer` calls.

- **Projects/workspaces/folders** (`routes/projects.ts`, new `routes/folders.ts`): direct
  `ProjectManager` calls — `createWorkspaceFolder`, `renameWorkspaceFolder`,
  `deleteWorkspaceFolder`, `setWorkspaceFolder`, `renameWorkspace`, `setWorkspaceHidden`,
  `reorderWorkspaces`, `reorderProjects`, `updateProject`, `removeProject`,
  `convertMainToWorktree`, `canQuickMerge`/`quickMergeWorktree`, `linkIssueToWorkspace`/
  `unlinkIssueFromWorkspace`/`getWorkspaceIssues`, `listLocalBranches`/`listRemoteBranches`,
  `resyncDefaultBranches`.
- **Tabs/panes** (`routes/panes.ts` + `src/lib/app-commands.ts`): `select-tab`, `close-tab`,
  `close-other-tabs`, `close-tabs-to-right`, `pin-tab`, `duplicate-tab`, `reorder-tabs`,
  `next-tab`/`prev-tab`, `open-diff`, `set-pane-title`/`clear-pane-title`, `move-pane`,
  `extract-pane-to-tab`, `reopen-closed-pane`, `focus-next-pane`/`focus-prev-pane`,
  `set-active-workspace`. Each renderer handler validates before writing, per the file's rule.
- **Agents/sessions** (`routes/agents.ts`): `POST /agents/:id/rename`, `DELETE /agents/:id`,
  `POST /agents/:id/seen`, `GET /agents/:id/resume-command`, plus tools for the already
  existing `POST /sessions/interrupt` and `POST /sessions/end`.
- **Git** (new `routes/git.ts`, prefix `/git`): thin wrappers over `backend.git` —
  `stage`, `unstage`, `discard`, `stash`, `commit`, `push` (drains `pushStream` and returns
  the collected lines and exit code), `staged-files`, `diff` (`local` or `full` against the
  project default branch). All take `cwd`, defaulting to the caller's workspace via `/context`.
- **Integrations** (new `routes/integrations.ts`): Linear `start-issue`/`close-issue`,
  GitHub `status`/`create-issue`.
- **System** (new `routes/system.ts`, prefixes `/notifications`, `/processes`, `/ports`,
  `/preferences`, `/theme`, `/stats`, `/remote-control`, `/shell`, `/windows`, `/updater`) and
  webview extras (`zoom-in`/`zoom-out`/`zoom-reset`/`find`/`mute`/`stop`) added to the
  `/webview/:id/*` block in `webview-server.ts` next to their siblings.

### 3. Tools

New definitions go into the module that owns the domain (`tools-projects`, `tools-panes`,
`tools-agents`, `tools-sessions`, `tools-webview`) plus two new modules `tools-git.ts` and
`tools-system.ts`, registered in `electron/mcp/modules.ts` with labels `git` and `system`.
Descriptions follow the existing voice: first sentence is the one-liner `manor --help` shows.
Every tool with a `projectId`, `workspacePath`, or `cwd` argument defaults it through
`resolveContext` (ADR-150) so `manor rename-workspace --name x` works from inside the workspace.

Both surfaces get every tool. The MCP roster grows from 35 to roughly 95; Claude Code defers
MCP schemas until first use and the ADR-170 SessionStart hint steers Claude toward the CLI, so
the standing cost is bounded there. Making per-module MCP registration opt-in is a follow-up,
not a blocker.

### 4. What stays out

- `selectProject(index)` / `selectWorkspace(projectId, index)` on `ProjectManager`: index-based
  sidebar selection; `set-active-workspace` by path covers the real use.
- Streaming watchers (`branches:start`, `diffs:start`, `ports:startScanner`): the CLI is
  one-shot; `git diff` and `ports scan` cover the read side.
- Keybindings, clipboard, dialogs, detach/reattach of tabs across windows, layout save/load:
  UI-only or dangerous without a human present.
- Remote-control `pair` and `revoke` are exposed read-mostly: `status`, `enable`/`disable`,
  `start-tunnel`/`stop-tunnel`; pairing stays in the UI.

## Consequences

**Better**

- ~60 new operations for agents and scripts with no new architecture; every one is a
  route + tool pair following a pattern that already exists in the same file.
- The `IpcDeps` / `ControlDeps` split stops being a source of "the route can't reach that";
  one bag, assembled once.
- Inline IPC logic (processes, editor) becomes callable, testable functions.
- Folder management, the request that prompted this, is a direct `ProjectManager` call and
  lands in the first slice.

**Worse / risks**

- Destructive operations become scriptable: `remove-project`, `delete-agent`, `git discard`,
  `kill-all-processes`, `quit-and-install`. Each must validate its target and refuse on
  ambiguity; none takes a "force" default. The CLI's exit-code contract makes mistakes
  visible but not reversible.
- MCP roster ~2.7x larger. Bounded by deferral in Claude Code, unbounded in Codex/Pi.
- Renderer-proxied routes still return `503` when no window is open; the system slice adds
  more of them (`open-diff`, `set-active-workspace`). Documented, not fixed.
- `git push` over HTTP blocks the request for the duration of the push. Acceptable for a CLI;
  a timeout of 5 minutes guards the server.
- `routes/index.ts` and `mcp/modules.ts` are touched by three tickets, forcing them sequential.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
