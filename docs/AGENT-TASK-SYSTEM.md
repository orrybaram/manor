# Manor Agent / Task System

This document describes how Manor models, persists, executes, and surfaces
"tasks" — the lifecycle records that wrap an agent CLI (Claude Code, Codex,
Pi) running inside a pane's PTY session. Flaws are flagged inline as
**🚩 Flaw**.

---

## 1. Vocabulary

| Term | Definition |
|------|------------|
| **Pane** | A leaf in the workspace's pane-tree layout. 1:1 with a PTY session. Identified by `paneId`. |
| **PTY session** | A forked subprocess (`pty-subprocess.js`) running a user shell, owned by the daemon. `sessionId === paneId`. |
| **Agent** | A CLI process running inside the pane's shell (e.g. `claude --dangerously-skip-permissions`). Detected by `AgentDetector` and via hook callbacks. Has no persistent record of its own. |
| **Agent session** | Logical conversation state inside the agent CLI (Claude Code's `session_id`, Codex's session, etc.). Sent by the agent in every hook payload as `session_id`. |
| **Task** | The persisted lifecycle record stored by Manor that pins an agent session to a pane and project. Identified by a UUID `task.id`, keyed internally by `agentSessionId`. |
| **Connector** | Per-agent integration adapter (`ClaudeConnector`, `CodexConnector`, `PiConnector`) that knows how to register hooks/MCP and build resume/prompt commands. |

A **task** is therefore a metadata wrapper around a (pane × agent session)
pairing. There is no "agent" entity at rest; only its kind + last status
recorded on the task.

---

## 2. File Layout

### Main process (`/electron`)

| File | Lines | Role |
|------|-------|------|
| `task-persistence.ts` | 210 | `TaskManager` — JSON store at `~/.manor/tasks.json`, in-memory `Map<agentSessionId, TaskInfo>`. |
| `hook-relay.ts` | 385 | Pure-function factory that builds the hook → task lifecycle state machine. |
| `agent-hooks.ts` | 221 | HTTP server (random port) that receives curl callbacks from agent hook scripts. Owns the embedded bash hook script. |
| `agent-connectors.ts` | 551 | Connector classes per agent kind. Writes hooks into `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.pi/agent/extensions/manor-hooks.ts`. |
| `app-lifecycle.ts` | 383 | App boot orchestration: spawn daemon, start hook server, wire relay, register IPC, start sweep interval. |
| `prewarm-manager.ts` | 134 | Single-slot prewarm of a blank PTY session, with command pre-injection. |
| `ipc/tasks.ts` | 146 | IPC handlers for `tasks:*`. |
| `ipc/pty.ts` | ~182 | IPC handlers for `pty:*`. |
| `terminal-host/agent-detector.ts` | 395 | Per-session state machine for live agent status (heuristic detection from stdout / OSC titles / process names). |
| `terminal-host/session.ts` | ~600 | PTY session: spawns subprocess, runs headless xterm, emits stream events. |

### Renderer (`/src`)

| File | Role |
|------|------|
| `store/task-store.ts` | Zustand store holding paginated `tasks[]` + `unseenRespondedTaskIds` / `unseenInputTaskIds` caches. Subscribes to `task-updated` IPC; primes from `tasks:getUnseen` on boot. |
| `store/app-store.ts` | Massive Zustand store (2k+ lines) holding layout, panes, terminals, agent statuses, project selection. |
| `components/sidebar/TasksList.tsx` | Sidebar list (active + recent). |
| `components/sidebar/TasksView/TasksView.tsx` | Modal: full history grouped by date. |
| `components/ui/AgentDot/AgentDot.tsx` | Visual indicator (color + pulse animation per status). |
| `components/CloseAgentPaneDialog.tsx` | Confirm-on-close-with-active-agent. |
| `hooks/useTerminalLifecycle.ts` | Auto-resume side-effect (uses `task.resumedAt` to dedupe). |
| `utils/task-navigation.ts` | Navigate to a task: select project → workspace → tab → focus pane → mark seen. |

### On-disk

| Path | Format | Owner |
|------|--------|-------|
| `~/.manor/tasks.json` | `{ tasks: TaskInfo[] }` | `TaskManager` |
| `~/.manor/hook-port` | Decimal int | `AgentHookServer` |
| `~/.manor/manor-agent-hook.sh` | Bash | `ensureHookScript()` |
| `~/.claude/settings.json` (mutated) | JSON | `ClaudeConnector.registerHooks` |
| `~/.claude.json` (mutated) | JSON | `ClaudeConnector.registerMcp` |
| `~/.codex/hooks.json` (mutated) | JSON | `CodexConnector.registerHooks` |
| `~/.codex/config.toml` (mutated) | TOML (text-edited) | `CodexConnector` |
| `~/.pi/agent/extensions/manor-hooks.ts` (written) | TS source | `PiConnector.registerHooks` |

---

## 3. Domain Model

### `TaskInfo` (`electron/task-persistence.ts:7-26`)

```ts
interface TaskInfo {
  id: string;                                            // UUID, stable identity
  agentSessionId: string;                                // Map key. Equals paneId for the *first* SessionStart of that pane (see flaw)
  name: string | null;                                   // Cleaned title from OSC 0/2; null until something usable arrives
  status: "active" | "completed" | "error" | "abandoned";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  activatedAt: string | null;                            // First time status reached an ACTIVE_STATUS
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  cwd: string;                                           // Snapshot at task creation; not updated when CWD changes
  agentKind: "claude" | "opencode" | "codex" | "pi";
  agentCommand: string | null;
  paneId: string | null;                                 // Nullable — orphaned tasks have null
  lastAgentStatus: string | null;                        // Last AgentStatus the relay applied (string, not typed enum)
  resumedAt: string | null;                              // ISO timestamp; consumed by useTerminalLifecycle to dedupe auto-resume
}
```

> **🚩 Flaw — `agentSessionId` ambiguity.** The field name implies "the agent's
> session ID" (e.g. Claude's `session_id`), but the relay also accepts hook
> events whose `session_id` is null and never creates a task in that case
> (`hook-relay.ts:138-143`). Worse, the field is *also* used as the Map key,
> so when an agent issues a SessionStart with a *different* `session_id` on
> the same pane (e.g. `/clear` or `--resume`), a new task is created and the
> old one is left dangling unless its lastAgentStatus was thinking/working
> (handled at `hook-relay.ts:145-172`). This conflates two identities and is
> the source of multiple downstream bugs. Document and rename, or split.

### `AgentState` (`electron/terminal-host/types.ts:95-101`)

```ts
interface AgentState {
  kind: AgentKind | null;     // null until detected
  status: AgentStatus;        // idle | thinking | working | complete | requires_input | error | responded
  processName: string | null;
  since: number;
  title: string | null;       // From OSC 0/2 escape sequences
}
```

`AgentState` is **per-session live state**, not persisted. The daemon's
`AgentDetector` owns it. Hook events are *relayed into* the detector via
`backend.pty.relayAgentHook(...)` in addition to driving task persistence —
so the two state machines run in parallel and can disagree, see flaws below.

### `SessionState` (`electron/hook-relay.ts:13-18`)

In-memory only, lives in the relay closure:

```ts
interface SessionState {
  activeSubagents: Set<string>;   // toolUseIds of currently running subagents
  hasBeenActive: boolean;         // Has the session ever reached an active status?
  pendingStopAt: number | null;   // Set when Stop is received but blocked by subagents
  lastHookEventAt: number;        // For idle sweep
}
```

Per-pane root session is also tracked: `paneRootSessionMap: Map<paneId, sessionId>`.
Used to ignore subagent SessionStart events that happen on the same pane.

> **🚩 Flaw — `SessionState` is not persisted.** On main-process restart,
> `sessionStateMap` is empty. The orphan-task sweep (Branch 3, ADR-132) is
> the only thing that recovers, but it waits 60s after `activatedAt` *and*
> only looks at lastAgentStatus thinking/working. A task last seen in
> `requires_input` will sit in that state forever after restart, with no UI
> cue, no notification re-fire, no abandonment.

---

## 4. Hook Pipeline (the Hot Path)

### 4.1 Boot

`app-lifecycle.ts:296-357` does, in order:

1. `agentHookServer.start()` — opens HTTP server on a random ephemeral port,
   writes the port to `~/.manor/hook-port` and to `process.env.MANOR_HOOK_PORT`.
2. `backend.connect(...)` — spawns the daemon subprocess, which inherits the
   env (so `MANOR_HOOK_PORT` is visible to PTYs the daemon will spawn later).
3. `prewarmManager.warm()` — fire-and-forget warm-up.
4. `createHookRelay(deps)` returns `{ relay, sweepStaleSessions, ... }`.
5. `agentHookServer.setRelay(relay)` — only now can hook events flow.
6. `setInterval(sweepStaleSessions, 10_000)`.

> **🚩 Flaw — boot ordering window.** Between step 2 and step 5, the daemon
> can spawn PTYs (e.g. layout restore) and a fast-running agent could fire
> hooks before the relay is wired. `agentHookServer.relayFn` is null then,
> so `this.relayFn?.(...)` silently drops events (`agent-hooks.ts:114`). No
> queueing, no log. In practice this is unlikely with claude (it takes time
> to start), but `--resume` of a finished session can fire SessionStart →
> SessionEnd in milliseconds and lose both.

### 4.2 Per-pane setup

When the renderer creates a pane, it calls `pty:create` (`paneId`, cwd, cols,
rows). The daemon spawns the pty-subprocess, which inherits `MANOR_HOOK_PORT`
and `MANOR_PANE_ID` from the env passed at spawn time. The renderer also
calls `tasks:setPaneContext` (`ipc/tasks.ts:62-75`) to register
`(projectId, projectName, workspacePath, agentCommand)` for the pane.

> **🚩 Flaw — `paneContextMap` is never cleaned up.** Set on
> `tasks:setPaneContext`, never deleted. There is no `tasks:clearPaneContext`
> handler. Closing a pane removes the pane from layout but leaves a stale
> entry in the map indefinitely. Memory leak; minor today, but unbounded
> across long uptime.

### 4.3 Hook script (the bash glue)

`agent-hooks.ts:151-199` embeds a bash script that:

1. Reads JSON from stdin (or `$1`).
2. Reads the port from `~/.manor/hook-port` (preferred) or `$MANOR_HOOK_PORT`.
3. Extracts `hook_event_name`, `session_id`, `tool_use_id` via *grep + tr*.
4. Sends `GET http://127.0.0.1:$PORT/hook/event?paneId=...&eventType=...&kind=...&sessionId=...&toolUseId=...`.

> **🚩 Flaw — bash regex parsing of JSON.** Lines 168, 174, 177 use
> `grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"'` to extract
> values. This is brittle: any escape sequence (`\"` inside a string), any
> nested object containing the same key, or any future schema change can
> break extraction silently. The script `exit 0`s on every error path — the
> agent never knows the hook failed.

> **🚩 Flaw — silent curl failures.** `curl ... > /dev/null 2>&1` discards
> errors. If the port file is stale (e.g. main process restarted with a new
> port and the agent still has an old `MANOR_HOOK_PORT` env), every hook
> call goes to a closed port, agent never knows. The `~/.manor/hook-port`
> read is a partial mitigation but only because curl is invoked fresh each
> time. The env-var fallback is dangerous on restart.

### 4.4 Hook server

`AgentHookServer` (`agent-hooks.ts:48-143`) parses the URL, maps eventType to
status via `mapEventToStatus` (`agent-hooks.ts:23-46`), and calls the relay.

`mapEventToStatus`:

| Event | Status |
|-------|--------|
| `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `SubagentStop` | `thinking` |
| `PreToolUse`, `SubagentStart` | `working` |
| `PermissionRequest`, `Notification` | `requires_input` |
| `Stop` | `responded` |
| `StopFailure` | `error` |
| `SessionEnd` | `idle` |
| (anything else) | `null` (event dropped) |

> **🚩 Flaw — `Notification` matcher is generic.** Claude Code's Notification
> hook fires for many reasons (auto-compact, generic info messages, idle
> input prompt). Connector registers it with matcher `"permission_prompt"`
> (`agent-connectors.ts:57`) which Claude treats as a free-form string;
> documentation suggests Claude only fires Notification with that matcher
> for permission-style notifications, but there is no validation here. A
> spurious Notification flips the task to `requires_input` indefinitely
> (until the next active event arrives or the sweep runs).

### 4.5 Relay (the state machine)

`createHookRelay(deps).relay` (`hook-relay.ts:128-299`):

```
┌──────────────────────────────────────────────────────────────────────┐
│  relay(paneId, status, kind, sessionId, eventType, toolUseId)        │
├──────────────────────────────────────────────────────────────────────┤
│  1. relayAgentHook(paneId, status, kind)  ──→ daemon AgentDetector   │
│  2. if !sessionId: log + return                                      │
│  3. if eventType === "SessionStart":                                 │
│       compare paneRootSessionMap[paneId] to incoming sessionId       │
│       if different and old session was thinking/working → force-stop │
│       set paneRootSessionMap[paneId] = sessionId                     │
│       return                                                         │
│  4. if rootSession ≠ sessionId: it's a subagent → return early       │
│  5. update sessionState (lastHookEventAt; activeSubagents +/−)       │
│  6. branch on status:                                                │
│     ACTIVE_STATUS (thinking/working/requires_input):                 │
│       upsert task; broadcast; maybe notify                           │
│     terminal status (responded/error/idle):                          │
│       Stop → if subagents active, defer; else applyStopForSession    │
│       SessionEnd → mark completed; clean up state                    │
│       StopFailure → mark error; clean up                             │
└──────────────────────────────────────────────────────────────────────┘
```

The "upsert task" branch (`hook-relay.ts:200-249`) is where new tasks come
into being. It is also where multiple flaws live:

> **🚩 Flaw — orphaning prior pane task.** When a new ACTIVE event arrives
> with a sessionId not yet seen, the relay calls
> `taskManager.getTaskByPaneId(paneId)` and, if found, *unlinks* its paneId
> (`hook-relay.ts:207-210`) — but does **not** mark it abandoned, completed,
> or anything else. The previous task simply loses its pane and stays in
> whatever status it had. If it was `thinking`/`working` it will be caught
> by the orphan sweep after 60s; if it was `requires_input` or `responded`
> it will sit in the task list, paneless, forever.

> **🚩 Flaw — incomplete SessionStart replacement.** When a *new* SessionStart
> arrives on a pane that already had a root session, the old session is only
> force-closed if its `lastAgentStatus` was `thinking` or `working`
> (`hook-relay.ts:153-154`). If it was `requires_input`, the old task stays
> active and `paneId`-pointing-at-the-pane until something else clears it.
> The renderer then has two task records both pointing to the same pane.

> **🚩 Flaw — `cwd` is never refreshed.** Set once at task creation from
> `paneContext.workspacePath`. If the user `cd`s during the session, the
> task record continues to show the original cwd. Live cwd is tracked
> separately on the session via OSC 7, but never propagated to the task.

> **🚩 Flaw — `agentKind` source mismatch.** Task creation pulls `kind` from
> the hook URL params (defaulting to `"claude"` at `agent-hooks.ts:100`),
> not from `paneContext.agentCommand`. If the agent's hook script doesn't
> set `MANOR_AGENT_KIND`, the kind silently defaults to `"claude"` even for
> codex/pi sessions.

### 4.6 Stop / SessionEnd ordering

The agent hooks emit `Stop` after each assistant turn. `SessionEnd` fires only
when the agent process exits. The relay treats them differently:

- `Stop` → `applyStopForSession` → task stays `status: "active"`,
  `lastAgentStatus: "responded"`. Pane and session stay alive.
- `SessionEnd` → task becomes `status: "completed"`. State is cleaned up.

This is the right model — a task is "complete" only when the agent process
exits, not after a single response — but it has a quirk:

> **🚩 Flaw — pendingStopAt cleared on terminal events.** When `SessionEnd`
> or `StopFailure` arrives while `pendingStopAt` is non-null (i.e. a Stop is
> waiting on subagents), the relay deletes the session state without
> applying the pending Stop. The task is force-completed/errored, which is
> fine, but no subagent-cleanup notification is emitted and the
> `unseenRespondedTasks` set never sees this task. Could miss notifications
> on a fast Stop→SessionEnd.

### 4.7 Sweep (`hook-relay.ts:301-359`)

Every 10s the relay walks state and forces progress on stuck sessions.
Three independent branches:

| Branch | Predicate | Action | ADR |
|--------|-----------|--------|-----|
| 1 | `pendingStopAt !== null && idle > 15s` | Force-apply Stop on session | ADR-130 |
| 2 | `hasBeenActive && idle > 60s` & lastStatus ∈ {thinking,working} | Force-apply Stop | ADR-131 |
| 3 | task is active, has no `sessionState`, lastStatus ∈ {thinking,working}, age > 60s | Force-apply Stop | ADR-132 |

> **🚩 Flaw — sweeps never recover `requires_input` orphans.** All three
> branches hard-code `thinking | working`. A task that ended up in
> `requires_input` and lost its session (process died, hook never fired)
> will never be touched. Surface bug: app shows a task as awaiting input
> but pressing the input does nothing because the agent is gone.

> **🚩 Flaw — branches 1 + 2 use wall clock not monotonic time.** `Date.now()`
> jumps across system suspend/resume and clock-sync. After a laptop sleeps
> for an hour and wakes, every active task's `idle` is suddenly > 60s and
> the sweep force-completes everything alive. There is no
> `process.hrtime()` guard. Branch 3 has the same issue with `activatedAt`.

### 4.8 Notification bridge

`notifyAgentDetectorGone` (`hook-relay.ts:361-381`) is invoked from the
stream handler in `app-lifecycle.ts:160-162` whenever the AgentDetector
reports `kind === null && status === idle`. It treats this as "the agent
process went away" and force-applies Stop on the root session.

> **🚩 Flaw — two-way coupling between AgentDetector and relay.** The
> AgentDetector lives in the daemon and runs heuristic detection on the
> session's stdout. Its `idle/null` signal is *also* driven by hook events
> (via `relayAgentHook`). So the detector can flip to idle because of a
> hook, then the stream handler treats that as "agent gone" and the relay
> double-fires. There is a guard at `hook-relay.ts:367-371` (only force if
> lastStatus was thinking/working) that mostly prevents the double-fire,
> but the design is fragile.

---

## 5. PTY / Execution Layer

### 5.1 Daemon

`TerminalHostClient` (`electron/terminal-host/client.ts`) connects (over IPC
to a fork'd subprocess) to the **daemon**, which owns:

- A `Map<sessionId, Session>`.
- Each `Session` forks `pty-subprocess.js`, which spawns the user shell.
- A `HeadlessTerminal` (xterm-headless) per session so the renderer can
  request a snapshot for layout restore.
- An `AgentDetector` per session that watches stdout for OSC 0/2 titles,
  process-name strings, and known agent CLI banners to derive `AgentState`.

Stream events flow back to the main process via `client.onEvent` and are
forwarded to the renderer over `pty-output-${paneId}` etc. (see
`app-lifecycle.ts:101-172`).

### 5.2 Prewarm

`PrewarmManager` (`prewarm-manager.ts`) keeps **at most one** blank PTY
session warmed in the background. State machine: `idle → warming → ready`.
On `consume()`, returns the prewarmed paneId and immediately starts a new
warm. On `updateCwd()` (called when the user switches workspace), disposes
old + warms fresh.

The agent command (`claude --dangerously-skip-permissions` etc.) is injected
into the warmed shell via `client.writeAfterReady(paneId, command + "\n")`,
so by the time the user "consumes" the session, the agent is already booting.

> **🚩 Flaw — single slot is restrictive.** Only one prewarmed session ever.
> User opening two new tabs in quick succession gets one fast pane and one
> normal cold-start. Could trivially be a small ring (size 2-3) for the
> common "burst of new agents" pattern.

> **🚩 Flaw — no daemon-reconnect recovery.** If the daemon process dies and
> respawns, the prewarmed sessionId is gone but `PrewarmManager.state` is
> still `"ready"`. There is a `reset()` method but nobody calls it on
> reconnect. Next `consume()` returns a stale paneId; the next IPC for that
> pane fails.

> **🚩 Flaw — race window in `updateCwd`.** Comments at `prewarm-manager.ts:42-47`
> describe a "superseded" check: an in-flight `warm()` checks
> `this.warmingPaneId !== paneId` after the create resolves. But the
> `dispose()` called from `updateCwd` clears `warmingPaneId` immediately,
> so any pending writeAfterReady from the original warm has already been
> issued before the in-flight create even returns. Result: the orphaned
> pane gets the agent command queued before being killed, possibly visible
> as a phantom write on the next ms tick.

---

## 6. UI Surface

### 6.1 Sidebar list

`TasksList.tsx` shows two sections:

- **Active**: `tasks.filter(t => t.status === "active")`.
- **Recent**: completed/error tasks whose `paneId` is still present in the
  current workspace's pane tree (so closing a pane removes recent entries
  from the sidebar — by design, history modal still has them).

Each row renders `<AgentDot>` whose pulse animation depends on
`status` + `seenTaskIds`. Click → `navigateToTask(task)`.

### 6.2 History modal

`TasksView/TasksView.tsx` shows everything, grouped Today / Yesterday / This
Week / This Month / Older, filtered by status pill (All / Active /
Completed-incl-error+abandoned). Resume → navigate; delete → IPC
`tasks:delete`.

> **✅ Resolved (ADR-136 T2) — pagination.** Boot now calls `tasks:getActive` for the sidebar plus `tasks:getAll({limit:100, offset:0})` for the first history page; `loadMoreTasks` is wired to a scroll sentinel in the history modal.

> **✅ Resolved (ADR-136 T2) — retention.** `TaskManager` constructor calls `pruneOlderThan(taskRetentionDays)` (default 90, 0 disables). One-time toast surfaces the prune count via `tasks:consumePruneNotice`, gated by the `taskPruneNoticeShown` preference.

### 6.3 Navigation atomicity

`navigateToTask` (`utils/task-navigation.ts:8-88`) does a *sequence* of
Zustand mutations: select project → select workspace → select tab → focus
pane → mark seen. Comments suggest atomicity, but it's actually four
discrete `setState` calls. Each triggers a render.

> **✅ Resolved (ADR-136 T4) — atomic navigation.** Added `navigateToContext` to `useAppStore`: a single `set(state => ...)` call that updates `activeWorkspacePath`, `activePanelId`, `selectedTabId`, and `focusedPaneId` together. `navigateToTask` calls it once instead of four discrete `setState`s.

### 6.4 Toast / notification dual-source

`receiveTaskUpdate` (`store/task-store.ts:108-222`):

- Compares `prevStatus` vs `nextStatus` to decide whether to show a toast.
- Skips toast if the task's pane is already visible in the active tab.
- Calls `markSeen` (renderer + main) when visible.

The OS-level desktop notification is fired separately by `maybeSendNotification`
in the **main process** based on its own preferences and the `task-updated`
broadcast. The two paths are independent.

> **✅ Resolved (ADR-136 T3) — single source of truth for unseen.** Main is authoritative; renderer holds a cache. `task-updated` broadcast payload is now `(task, { responded, requires_input })` — flags reflect main's Sets at broadcast time. Renderer drops its local "clear seen on status change" branch. `tasks:markSeen` re-broadcasts via `sendTaskUpdate` so the cache stays in sync. Boot primes the cache from `tasks:getUnseen`. Single send-site: `sendTaskUpdate` in `electron/notifications.ts`.

---

## 7. IPC Surface

### 7.1 `tasks:*` (renderer → main)

| Channel | Purpose |
|---------|---------|
| `tasks:getAll(opts?)` | Read with optional `{projectId,status,limit,offset}` |
| `tasks:getActive()` | Fast path: just active tasks, no sort/slice (ADR-136 T2) |
| `tasks:getRecent({limit})` | Top-N most recent (ADR-136 T2; defensively exposed, not yet consumed) |
| `tasks:getUnseen()` | `{responded: string[], requires_input: string[]}` — primes renderer cache (ADR-136 T3) |
| `tasks:get(taskId)` | Single task lookup (linear scan) |
| `tasks:update(taskId, {name?})` | Renderer-writable allowlist (ADR-136 T1). Lifecycle fields rejected. |
| `tasks:markResumed(taskId)` | Sets `resumedAt` from main; replaces renderer-side write (ADR-136 T1 follow-up) |
| `tasks:delete(taskId)` | Remove + clear unseen flags + update dock |
| `tasks:markSeen(taskId)` | Clear unseen flags, update dock, re-broadcast `task-updated` (ADR-136 T3) |
| `tasks:consumePruneNotice()` | One-shot read of last prune count, gated by `taskPruneNoticeShown` preference (ADR-136 T2) |
| `tasks:setPaneContext(paneId, ctx)` | Register projectId/name/workspacePath/agentCommand for a pane |
| `tasks:abandonForPane(paneId, title?)` | Called on pane close — flip active task to `abandoned` |
| `tasks:reconcileStale()` | Diff `getActiveTasks()` against `backend.pty.listSessions()`; abandon orphans whose `lastAgentStatus !== "responded"` |

### 7.2 `tasks:update` allowlist (ADR-136 T1)

The handler validates `updates` against `ALLOWED_RENDERER_TASK_FIELDS` (today: `name`) and throws on any other key. Lifecycle fields (`status`, `agentSessionId`, `lastAgentStatus`, `activatedAt`, `completedAt`, `resumedAt`, `paneId`) are owned by main; widening the allowlist is a deliberate decision, not a default.

> **✅ Resolved — IPC trust boundary.** Renderer can no longer rewrite `agentSessionId` (the Map key) or any lifecycle field. `tasks:markResumed` provides the one auxiliary path the renderer needed.

### 7.3 `tasks:get` is O(n)

`ipc/tasks.ts:32-36` does `taskManager.getAllTasks().find(t => t.id === taskId)`
on every call. With 10k tasks plus the sort step inside `getAllTasks`, this
is gratuitous. `TaskManager` only indexes by `agentSessionId`, not by `id`.

### 7.4 `task-updated` broadcast (main → renderer)

Single channel, payload is `(task: TaskInfo, unseen: { responded: boolean; requires_input: boolean })` (ADR-136 T3). The unseen flags reflect main's `unseenRespondedTasks` / `unseenInputTasks` Sets at the moment of the broadcast. Sent via `sendTaskUpdate` in `electron/notifications.ts` — the single send-site, called from the relay, the stream handler (when the agent title changes), `tasks:abandonForPane`, `tasks:reconcileStale`, and `tasks:markSeen`. No batching, no diff.

---

## 8. Persistence + Identity

### 8.1 Save model

`saveState()` (`task-persistence.ts:66-77`): debounced 500ms. On every
debounce, **serialize and rewrite the entire file**. No append-only log, no
fsync, no atomic rename, no lock.

> **🚩 Flaw — non-atomic write.** `fs.writeFileSync(path, json)` is not
> atomic. Crash mid-write yields a truncated/half-written `tasks.json` and
> `loadState` returns an empty Map (the catch-all at line 61 swallows the
> JSON parse error). Result: **all task history lost** on a crash during
> the 500ms debounce window. Should write to `tasks.json.tmp` then
> `fs.renameSync`.

> **🚩 Flaw — no concurrent-window safety.** Two Manor windows pointed at
> the same home dir would clobber each other's writes. Today the app
> single-instances at the OS level, but there's no defense in depth (no
> file lock).

### 8.2 Identity collisions

`agentSessionId` is the Map key. If two distinct PTY sessions on different
panes ever produce the same agent `session_id` (e.g. resuming the same
Claude session in two panes), the second SessionStart will overwrite the
first. The relay does have logic to migrate `paneId` on the existing task
(`hook-relay.ts:206-210`) — but it does so by **clearing the old pane**, so
both panes silently end up sharing one task while one of them no longer has
any task at all.

### 8.3 Reconciliation

On main-process startup, `tasks:reconcileStale` (`ipc/tasks.ts:104-144`)
diffs in-memory active tasks against the daemon's live session list. It
abandons any active task whose `agentSessionId` is not in the live set
**and** whose `lastAgentStatus !== "responded"`.

> **🚩 Flaw — `reconcileStale` is renderer-triggered.** Nothing in
> `app-lifecycle.ts` calls it. It runs only when the renderer boots and
> dispatches it (location not auditable here). If the renderer crashes
> without booting, abandoned tasks linger as "active" until the orphan
> sweep catches them 60s later — and only if their lastStatus was
> thinking/working.

> **🚩 Flaw — `agentSessionId` ≠ daemon `sessionId`.** The reconcile compares
> `task.agentSessionId` (the agent CLI's session id, e.g. Claude's UUID)
> against the daemon's pane-keyed `sessionId` (which is `paneId`). These
> are different namespaces. The first task ever created on a pane happens
> to have `agentSessionId === paneId` only because the first SessionStart's
> session_id is what we got. Subsequent sessions on the same pane get a
> new agent session_id but the daemon session_id (paneId) is unchanged.
> The reconcile will incorrectly mark *every* post-first task as
> abandoned. **Likely real bug.** Worth tracing through manually.

---

## 9. Concurrency / Scheduling

There is no queue. Anything that wants to start an agent does so. The only
concurrency primitives:

1. The 500ms `saveState` debounce serializes disk writes.
2. The relay is single-threaded (Node event loop) — `relay()` itself runs to
   completion before the next hook event is processed.
3. Subagent tracking (`activeSubagents` Set) defers `Stop` so the parent
   task doesn't flip to `responded` while a subagent is running.

There is no per-project, per-workspace, or global limit on how many agents
run simultaneously.

> **🚩 Flaw — no admission control.** A user could (intentionally or
> accidentally — script, hotkey storm) launch 50 agents at once. Each
> spawns a PTY, each registers a SessionState, each runs `claude` with
> `--dangerously-skip-permissions`. Nothing pushes back. Memory and CPU
> impact unbounded. Even a soft cap with a "you have N agents running"
> warning would help.

---

## 10. Integration Points

### 10.1 Pane / tab

- Pane close → renderer's `closePaneById` → `tasks.abandonForPane(paneId)`.
- Pane stays in layout until manually closed; recent completed tasks remain
  visible in the sidebar's "Recent" section as long as the pane exists.

### 10.2 Project / workspace

- Linked at task creation time via `paneContextMap`.
- Never updated. If a user moves a workspace path on disk, all existing
  tasks with the old path are unfindable by `tasks:getAll({projectId})`
  going forward.

### 10.3 Git

- No direct integration. `cwd` snapshot only.
- `BranchWatcher` and `DiffWatcher` exist (`app-lifecycle.ts:67-68`) but
  are not joined to tasks.

### 10.4 MCP webview

- `manor-webview` MCP server is registered with each connector
  (`agent-connectors.ts:135-172` for Claude). Allows agents to control a
  webview pane via MCP tools (`mcp__manor-webview__*`).
- Lives outside the task lifecycle; no task field references it.

---

## 11. Dead / Suspect Code

| Site | Concern |
|------|---------|
| `task-persistence.ts:195-208` | `unlinkPane(paneId)` — defined, never called. The only place that wants this behavior (relay's "task-by-pane already exists" branch) inlines its own `updateTask` call. |
| `task-persistence.ts:46-64` | `claudeSessionId` → `agentSessionId` migration. Live as long as users have legacy state; eventually pure cruft. |
| `agent-connectors.ts:495-501` | `PiConnector.registerMcp` is empty save for a comment. Fine — but quietly skipped. |
| `agent-detector.ts` | 395 lines of heuristic detection that runs *in addition to* hook events. With hook-driven status now authoritative, much of the heuristic detection (process polling, banner matching) duplicates the hook signal. Audit candidate. |

---

## 12. Consolidated Flaw Summary

Severity is my judgment, not the team's.

### Critical

1. **`agentSessionId` ≠ daemon sessionId mismatch in `reconcileStale`** — likely false-abandons most active tasks after a multi-session pane. Verify against runtime behavior.
2. **Non-atomic `tasks.json` write** — crash mid-write silently empties task history.
3. **Sweeps and `notifyAgentDetectorGone` ignore `requires_input`** — input-pending tasks whose process dies become permanent zombies.
4. **`Stop` / `SessionEnd` race on `pendingStopAt`** — pending stop is dropped if SessionEnd arrives, no `unseenRespondedTasks` entry, missed notification.

### High

5. **Boot-window hook drop** — events between daemon spawn and `setRelay` are silently lost.
6. **Bash regex JSON parsing** — fragile; hides errors with `exit 0` and `> /dev/null 2>&1`.
7. **Wall-clock-based sweeps** — laptop sleep/wake force-completes everything alive.
8. ~~**Renderer-trusted `tasks:update`**~~ — ✅ Resolved (ADR-136 T1).
9. ~~**Initial `getAll()` loads everything**~~ — ✅ Resolved (ADR-136 T2: pagination + retention).
10. **Stale `paneContextMap` entries** — never deleted; small per-entry but unbounded in lifetime.

### Medium

11. **Incomplete `SessionStart` replacement** — only handles thinking/working; requires_input dangles.
12. **Orphan-prior-pane-task on new SessionStart** — old task's pane is unlinked but status is left as-is.
13. **`agentKind` defaults to `"claude"`** when hook URL omits it; can mislabel codex/pi tasks.
14. **`cwd` snapshot is never refreshed** during a session.
15. **PrewarmManager has no daemon-reconnect recovery** — stale paneId after daemon restart.
16. **PrewarmManager updateCwd race** — orphaned pane may get the agent command queued before kill.
17. **`tasks:get` linear scan + sort on every call.**
18. ~~**Dual seen-flag bookkeeping**~~ — ✅ Resolved (ADR-136 T3: main is authoritative; renderer is a cache).
19. ~~**Multi-step `navigateToTask` Zustand mutations**~~ — ✅ Resolved (ADR-136 T4: atomic `navigateToContext`).

### Low / speculative

20. **`Notification` matcher trust** — generic notifications may flip a task to `requires_input` spuriously.
21. **No admission control on agent spawning** — N agents at once is unbounded.
22. **`unlinkPane` is dead code.**
23. **AgentDetector heuristics duplicate hook signal** — audit candidate.
24. **Single-slot prewarm** — burst of new agents falls back to cold start.
25. **Two-way coupling between AgentDetector and relay via `notifyAgentDetectorGone`** — fragile feedback path.

---

## 13. Suggested Order of Operations (if you wanted to fix things)

1. ✅ Verify and fix the `reconcileStale` namespace bug — resolved by ADR-133 (reconcile by `paneId`, not `agentSessionId`).
2. ✅ Wrap `tasks.json` writes in tmp+rename — resolved by ADR-134 (atomic writes).
3. Add a `requires_input` arm to all three sweep branches and to `notifyAgentDetectorGone`.
4. Make sweep idle math monotonic (`process.hrtime.bigint()`).
5. ✅ Tighten `tasks:update` to an allowlist — resolved by ADR-136 T1.
6. Decide whether `agentSessionId` is "agent's session id" or "Manor's task key" and split the two if both are needed.
7. Rest of the list is cleanup / sturdiness work.
