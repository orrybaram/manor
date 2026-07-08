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

# ADR-144: MCP Agent Orchestration — Launch Agents & Fan Out GitHub Issues

## Context

ADR-110 shipped the `manor` MCP server with project/workspace CRUD tools
(`list_projects`, `add_project`, `create_workspace`, …). Agents can now read
and shape Manor's structure, but they cannot yet **do work** through it. The
highest-leverage next step — called out in ADR-110's "Future Use Cases" — is to
turn *"here are N GitHub issues"* into *N parallel agent workspaces*, in one
call.

That requires two capabilities that don't exist over MCP today:

1. **`start_agent`** — launch an agent session (e.g. Claude Code) in a specific
   workspace, optionally seeded with a prompt.
2. **`batch_create_workspaces`** — for a set of GitHub issues, create one
   workspace (git worktree/branch) per issue, link the issue, and optionally
   kick off an agent in each.

A third, supporting tool is needed so an agent can *see* the issues before
fanning out:

3. **`list_issues`** — list a project's GitHub issues (assigned to me / all).

### What the existing code gives us (research findings)

- **MCP + HTTP pattern (ADR-110):** the standalone `mcp-webview-server.ts`
  proxies MCP calls over HTTP to the in-Electron `webview-server.ts`
  (`WebviewServer`), which already owns `/projects…` routes and holds a
  `ProjectManager`. Both new tools belong here — no new server.
- **Workspace + issue link already exist:** `ProjectManager.createWorktree(
  projectId, name, branch, linkedIssue?, baseBranch?, useExistingBranch?)`
  (`persistence.ts:694`) already accepts a `linkedIssue` and persists it
  (`persistence.ts:813`). The current `POST /projects/:id/workspaces` route
  passes `linkedIssue: undefined` — batch just needs to thread it through.
- **GitHub API already exists:** `GitHubManager` (`electron/github.ts`) —
  `getMyIssues(repoPath, limit, state)`, `getAllIssues(...)`,
  `getIssueDetail(...)`, `assignIssue(repoPath, number)`. All shell out to `gh`.
- **Agents are launched by the *renderer*, not the backend.** A pane runs a
  login shell; the agent CLI is started by writing `"<agentCommand> \"<prompt>\"\n"`
  into that shell's stdin. The flow is `App.handleNewTaskWithPrompt` (`App.tsx:486`)
  → `setPendingStartupCommand` + `addTab` → pane mounts → `pty.create` →
  daemon spawns shell → renderer injects the command. **Main has no API to
  create a pane** — pane/layout state lives entirely in the renderer store.
- **Task tracking is automatic.** Once the agent boots and emits `SessionStart`,
  the hook relay (`hook-relay-effects.ts`) reads `paneContextMap` (populated by
  the renderer at pane mount) and calls `taskManager.createTask(...)`. We do not
  create task records ourselves.
- **Main → renderer bridge already exists** for menu/keyboard commands: App.tsx
  keeps a command-ID → action map (`handlersRef`, `App.tsx:302`) and the renderer
  listens on `ipcRenderer.on(...)` channels (see `preload.ts`). Main can already
  push events with `mainWindow.webContents.send(channel, …)`.

## Decision

**Extend the existing `manor` MCP server and `WebviewServer`** (same pattern as
ADR-110). Add three MCP tools backed by three HTTP endpoints, plus one small
main→renderer command bridge to launch agent panes.

### 1. Main → renderer command bridge (the load-bearing new piece)

Because pane creation is renderer-driven, `start_agent` cannot run entirely in
main. Add a generic app-command channel:

- **Main:** `WebviewServer.startAgent(workspacePath, prompt?)` sends
  `BrowserWindow.getAllWindows()[0].webContents.send("app-command", { cmd:
  "start-agent", workspacePath, prompt })`. (Reuse the `BrowserWindow.getAllWindows()`
  approach already used in `persistence.ts` for `worktree:setup-progress`.)
- **Preload:** expose `onAppCommand(cb)` on `electronAPI` and forward the
  `"app-command"` channel (mirrors existing `onTaskUpdated` etc.).
- **Renderer (`App.tsx`):** register an `onAppCommand` listener that, for
  `cmd === "start-agent"`, runs `await loadProjects()` (so a just-created
  workspace is visible), `setActiveWorkspace(workspacePath)`, then
  `handleNewTaskWithPrompt(prompt)` (or the no-prompt `handleNewTask` when
  `prompt` is absent). These handlers already exist.

Task tracking then happens automatically via the `SessionStart` hook — no task
record is created here.

### 2. New HTTP endpoints (on `WebviewServer`)

`WebviewServer` gains an optional `GitHubManager` (constructor param 3), used by
the issue routes. Endpoints:

| Endpoint | Method | Body / Query | Action |
|----------|--------|--------------|--------|
| `/projects/:id/issues` | GET | `?filter=assigned\|all&state=open&limit=50` | `github.getMyIssues` / `getAllIssues(project.path, …)` |
| `/agents` | POST | `{ projectId, workspacePath, prompt? }` | `startAgent(workspacePath, prompt)` → `{ ok: true }` |
| `/projects/:id/workspaces/batch` | POST | `{ issues: number[], baseBranch?, assign?, startAgent?, promptTemplate? }` | see below |

**Batch handler** — for each issue number:
1. Fetch detail (`github.getIssueDetail`) for title/body.
2. Build a `LinkedIssue` `{ id: String(number), identifier: "#<number>",
   title, url }` and a workspace/branch name (`slugify(title)` or
   `issue-<number>`).
3. `pm.createWorktree(projectId, name, undefined, linkedIssue, baseBranch)`.
4. If `assign`, fire `github.assignIssue(project.path, number)`.
5. If `startAgent`, resolve the new worktree path from the returned
   `ProjectInfo`, render `promptTemplate` (default: *"Work on GitHub issue
   #<number>: <title>. <body>"*), and call `startAgent(worktreePath, prompt)`.
6. Collect `{ issue, workspacePath, started }`; continue on per-issue errors and
   report them in the result (partial success, never abort the whole batch).

### 3. New MCP tools (in `mcp-webview-server.ts`)

| Tool | Input | Maps to |
|------|-------|---------|
| `list_issues` | `projectId` (req), `filter?` (`assigned`\|`all`, default `assigned`), `state?`, `limit?` | `GET /projects/:id/issues` |
| `start_agent` | `projectId` (req), `workspacePath` (req), `prompt?` | `POST /agents` |
| `batch_create_workspaces` | `projectId` (req), `issues` (req `number[]`), `baseBranch?`, `assign?`, `startAgent?` (default true), `promptTemplate?` | `POST /projects/:id/workspaces/batch` |

Return human-readable text summaries (matching the ADR-110 tool style), e.g.
batch returns one line per issue: `#123 → <worktreePath> (agent started)`.

### Future Use Cases (not in this ADR)

- **`get_agent_status`** — poll `taskManager.getAllTasks({ projectId })` so an
  orchestrator can await the fan-out. (Natural next ADR — closes the loop.)
- **`focus_workspace`**, **`merge_workspace`** (`quickMergeWorktree` exists),
  **`run_command`** (project `commands[]` exist), **`link_issue`**
  (`linkIssueToWorkspace` exists).

## Consequences

**Better**
- One MCP call turns a backlog into parallel agent workspaces — the flagship
  multi-agent workflow.
- Reuses `createWorktree`, `GitHubManager`, and the existing task-tracking hook;
  little genuinely new code beyond the routes and the command bridge.
- The `app-command` bridge is generic and reusable for future main-driven UI
  actions (`focus_workspace`, etc.).

**Harder**
- `WebviewServer` takes on GitHub + agent-launch responsibilities in addition to
  webviews and projects. Still cleanly separated by URL prefix, but the "webview"
  name is now clearly a misnomer (tracked as debt; renaming the file is
  out of scope here).
- `start_agent` spans process boundaries (MCP → HTTP → main → renderer → daemon),
  so it is inherently fire-and-forget: it returns once the command is dispatched,
  before the agent is confirmed running.

**Risks**
- **Workspace-visibility race:** the renderer must `loadProjects()` before
  `setActiveWorkspace`, or a freshly-created worktree won't be selectable.
  Mitigation: the `start-agent` handler awaits `loadProjects()` first.
- **No window open:** if no `BrowserWindow` exists, `start_agent` silently no-ops.
  Mitigation: the route returns a clear error when `getAllWindows()` is empty.
- **`gh` not authenticated:** issue routes return `[]`/errors from `GitHubManager`;
  surface these as tool errors rather than empty success.
- **Prompt injection correctness:** prompts flow into a shell command string;
  reuse the existing escaping in `App.tsx:616` (backslash/quote/`$`/backtick/`!`).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
