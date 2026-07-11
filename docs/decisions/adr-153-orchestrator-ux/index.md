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

# ADR-153: Orchestrator UX — a pinned global agent that sees & steers every session

## Context

Issue [#159](https://github.com/orrybaram/manor/issues/159): *"add a top level
global terminal (auto-launch your agent harness) which can see every existing
session, create new sessions, and interact with the entire app."*

The goal is a **"mega-mind" orchestrator**: one always-on agent session, scoped
above any single project/workspace, that can observe all running work and act on
it at a high level — spawn tasks, fan out issues, and steer agents that are
already running.

### What already exists (research findings)

Manor already ships most of the *plumbing*. The orchestrator is, mechanically, an
agent session with the `manor` MCP server wired in plus a good primer prompt.

- **MCP → HTTP pattern (ADR-110/144/145).** A standalone MCP process
  (`electron/mcp-webview-server.ts`) proxies tool calls over HTTP to the
  in-Electron `WebviewServer` (`electron/webview-server.ts`). Tools are grouped
  into `ToolModule`s (`electron/mcp/types.ts`) registered in the `modules` array
  (`mcp-webview-server.ts:123`). HTTP routes live in `electron/routes/*` and are
  registered in `electron/routes/index.ts`. Existing tools already cover
  **spawn/fan-out**: `start_agent`, `batch_create_workspaces`, `list_issues`,
  `list_projects`, `list_panes`.
- **Task state lives in main.** `TaskManager` (`electron/task-persistence.ts`)
  owns every session as a `TaskInfo` — `id`, `agentSessionId`, `paneId`,
  `projectId`, `workspacePath`, `agentKind`, `agentCommand`, a persisted
  lifecycle `status` (`active|completed|error|abandoned`), and a live
  `lastAgentStatus` (`thinking|working|requires_input|responded|complete|
  error|idle`, mapped from hooks in `electron/agent-hook-events.ts`). Constructed
  in `electron/app-lifecycle.ts:149`. **This is exactly the "see every session"
  data — but it is not exposed over MCP today.**
- **pty stdin injection exists.** `backend.pty.write(paneId, data)`
  (`electron/pty.ts:100`, via `electron/ipc/pty.ts:92`). A `TaskInfo.paneId` *is*
  the pty session key. So injecting text/keys into a running agent is a single
  main-process call — no renderer round-trip.
- **Pane-keyed renderer surface (ADR-137).** `App.tsx` renders the active
  surface as `<PanelLayout key={activeWorkspacePath} …>` keyed by an **opaque
  string path** (`app-store.ts`: `workspaceLayouts: Record<string, …>`).
  `setActiveWorkspace(path)` creates/restores a layout for *any* string — nothing
  requires it be a real project workspace. Non-active workspaces stay mounted but
  hidden.
- **Agent launch flow.** `App.handleNewTask` / `handleNewTaskWithPrompt`
  resolve `agentCommand` and call `setPendingStartupCommand(workspacePath, cmd)`;
  the pane picks it up on mount (`useTerminalLifecycle.ts`) and writes it to the
  shell. `agentCommand` falls back to `DEFAULT_AGENT_COMMAND`
  (`src/agent-defaults.ts`, `"claude --dangerously-skip-permissions"`), and
  `getAgentKindForCommand` maps a command → `claude|codex|opencode|pi`.
- **Session persistence/resume.** `layout.json` +
  `electron/terminal-host/layout-persistence.ts` reconcile panes as
  `warm|cold|fresh` on relaunch; the auto-resume path in
  `useTerminalLifecycle.ts:301` re-launches interrupted agents.

### The gaps #159 actually needs to close

1. **The orchestrator can't *see* live session state over MCP.** No `list_tasks`
   tool — `list_panes` exists but carries no agent status. This is the
   load-bearing new capability.
2. **The orchestrator can't *steer* a running session.** It can spawn new agents,
   but there is no first-class "route a prompt into the agent already working on
   #159" — the ask decided on **interrupt + inject** semantics.
3. **There is no global, above-projects place** for the orchestrator to live, and
   no **agent-agnostic harness config** ("auto-launch *your* harness":
   claude/codex/custom).

### Decisions locked with the user

- **Placement:** a **pinned top-level "Orchestrator" session** in the sidebar
  (above the project list), its own persistent pane surface, one long-lived
  session that survives project switches and resumes on relaunch.
- **v1 scope:** thin — **see + spawn + steer**. No push-event feed (poll: the
  orchestrator asks, then acts).
- **Harness:** **agent-agnostic from v1** — `claude | codex | custom` — matching
  the ticket's "auto-launch *your* agent harness."
- **Steering semantics:** **interrupt + inject** — send the harness's graceful
  cancel key(s), then inject the prompt.

## Decision

Ship #159 as **one global surface + two new main-served MCP tools + a harness
abstraction**, reusing every existing pattern.

### A. Harness abstraction (the backbone)

Both "agent-agnostic launch" and "interrupt + inject" need per-harness knowledge
(interrupt key differs: claude `Esc`, others `Ctrl-C`; launch/idle differ). Define
a small adapter keyed by `agentKind`:

```ts
interface HarnessAdapter {
  kind: "claude" | "codex" | "custom";
  launchCommand(): string;          // full boot command for this CLI
  interruptSequence(): string;      // raw pty bytes to end current turn (e.g. "\x1b" or "\x03")
  isIdle(lastAgentStatus): boolean; // prompt-ready detection for steering
  primer(): string;                 // system-prompt / CLAUDE.md-equivalent seed
}
```

- **Renderer side** (`src/lib/harness.ts`): `launchCommand`, `primer`, `isIdle` —
  used to boot the orchestrator surface.
- **Main side**: a tiny `interruptSequence` map keyed by `agentKind` (needed by
  `send_to_session`'s pty write). `agentKind` already exists in both worlds
  (`agent-defaults.ts`, `TaskInfo.agentKind`), so no cross-tsconfig import is
  required — the interrupt map is a small standalone module in `electron/`.
- **Config:** new global preferences —
  `orchestratorHarness: "claude"|"codex"|"custom"` plus
  `orchestratorCustomCommand` / `orchestratorCustomInterrupt` for the `custom`
  case. Added to `AppPreferences` (`src/electron.d.ts`) + `defaultPreferences`
  (`preferences-store.ts`), edited on a new **Orchestrator** settings page
  (mirrors `GeneralSettingsPage.tsx`, registered in `SettingsModal.tsx`).

### B. Orchestrator pseudo-workspace + pinned sidebar entry

- A constant sentinel workspace path, `ORCHESTRATOR_PATH` (e.g.
  `"__orchestrator__"`, backed by a real cwd `~/.manor/orchestrator` so the CLI
  has somewhere to run). Layout keying already accepts opaque strings.
- **Pinned sidebar row** inserted in `Sidebar.tsx` *above* the "Projects" header
  (outside `projects.map`, so it's exempt from drag/reorder). Visual language
  mirrors the existing `isMain`/"local" home row in `ProjectItem.tsx` (house-style
  icon + fixed label). Clicking it calls `setActiveWorkspace(ORCHESTRATOR_PATH)`.
- **agentCommand resolution:** every `project?.agentCommand ?? DEFAULT_AGENT_COMMAND`
  fallback that can run for the sentinel path (`App.tsx` handlers,
  `useTerminalLifecycle.ts`) is taught to use the resolved orchestrator harness
  command when `workspacePath === ORCHESTRATOR_PATH`.
- **Auto-launch:** on first open, seed `pendingStartupCommand[ORCHESTRATOR_PATH]`
  with the harness launch command, and seed the primer as the first prompt.
- **Resume on relaunch:** the sentinel persists in `layout.json` like any
  workspace; on boot, restore/re-activate it and re-launch the harness via the
  existing pending-command / auto-resume machinery.

### C. `list_tasks` MCP tool (see)

- New `electron/routes/tasks.ts` → `GET /tasks?projectId=&status=&limit=&offset=`
  reading `taskManager.getAllTasks(...)` / `getActiveTasks()`. Register in
  `routes/index.ts`.
- **Deps threading:** add `taskManager` to `ControlDeps` (`routes/types.ts`),
  thread it through `createWebviewServer` (`ipc/webview.ts`) and the
  `WebviewServer` constructor (`webview-server.ts`) from the call site
  (`app-lifecycle.ts`).
- New `electron/mcp/tools-tasks.ts` exporting a `tasksModule: ToolModule` with a
  `list_tasks` tool → `http.get("/tasks?…")`, formatted to a compact table
  (task handle, project/branch, `lastAgentStatus`, linked issue, PR, paneId).
  Register the module in `mcp-webview-server.ts:123`. **Entirely main-served.**

### D. `send_to_session` MCP tool (steer — interrupt + inject)

- Same `tasksModule`: `send_to_session(target, text)` where `target` accepts a
  task handle (`id`/`#issue`/branch) or a raw `paneId`.
- New `POST /sessions/send` route: resolve target → `TaskInfo.paneId`; look up the
  harness `interruptSequence()` by `task.agentKind`; then
  `backend.pty.write(paneId, interruptSequence)` followed by
  `backend.pty.write(paneId, text + "\r")`. Requires adding `backend` to
  `ControlDeps` (threaded alongside `taskManager`).
- **Guardrails:** the interrupt is the harness's *graceful* cancel (never a
  process kill). The route returns the target's `lastAgentStatus` so the caller
  knows it interrupted a `working` agent; the primer's house rules gate when to
  do so.

### E. Primer + soft guardrails

- `src/lib/orchestrator-primer.ts`: the seed prompt describing manor's model
  (projects → workspaces → panes → tasks), the tool catalog (incl. the two new
  tools), and **house rules**: a concurrency cap on fan-out, confirm before
  destructive actions, and do not let spawned child agents themselves recurse into
  orchestration (depth cap). v1 enforces these at the primer/behavioral level;
  hard enforcement is a fast-follow.

## Consequences

**Better**
- #159's headline capability lands: one place to observe and drive all work.
- `list_tasks` and `send_to_session` are reusable by *any* MCP client, not just
  the orchestrator.
- Both new tools are main-served (taskManager + pty) — no fragile renderer
  round-trip, unlike `start_agent`/pane tools.
- Reuses pane-keyed layout, persistence/resume, agent-launch, and MCP-module
  patterns wholesale; little genuinely new surface.

**Harder / riskier**
- **Interrupt + inject timing is the sharp edge.** Writing keys/text to a pty
  mid-turn can discard in-flight work or land at the wrong moment; `isIdle`
  detection is per-harness and may be flaky. This is the piece to de-risk first
  (prototype against a live `claude` pane before trusting it).
- **Agent-agnostic harness** means per-harness launch/interrupt/primer config;
  `custom` puts correctness partly in the user's hands.
- The sentinel pseudo-workspace has no owning project, so every
  `projects.find(… === activeWorkspacePath)` site must tolerate `undefined` and
  fall back to the orchestrator command — a small but cross-cutting set of edits.
- **Blast radius:** an agent that can fan out N sessions and steer any of them is
  powerful; v1's guardrails are soft (primer-level). Recursion/concurrency caps
  are behavioral until a later hardening pass.

**Deferred (not in v1)**
- Push-event feed (reactive "do the next thing" on task-done/stuck/PR events).
- A dedicated cross-session steering *UI* (v1 exposes steering via the tool only).
- Hard enforcement of concurrency/recursion caps.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
