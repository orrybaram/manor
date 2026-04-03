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

# ADR-021: Centralize Task State — Single Source of Truth

## Context

Tasks currently have **three independent sources of state** that get merged/reconciled at render time:

1. **`useTaskStore`** — persisted `TaskInfo` objects from the main process (`task-persistence.ts`), updated via IPC `task-updated` broadcasts.
2. **`paneAgentStatus` in `useAppStore`** — live `AgentState` objects per pane, updated via PTY daemon `pty-agent-status` IPC events. Contains `kind`, `status`, `processName`, `since`, `title`.
3. **`useAllAgents()` hook** — derives a `GlobalAgent[]` list by walking all projects/workspaces/sessions and collecting non-idle entries from `paneAgentStatus`.

This causes two problems:

- **TasksView.tsx** merges persisted tasks with live agents, creating **synthetic `TaskInfo` objects** for agents not yet persisted. The synthetic name falls back to `agent.agent.kind` (literally `"claude"`), which is the bug that causes task names to show as "claude".
- **TasksList.tsx** (sidebar) renders directly from `useAllAgents()` with its own `cleanAgentTitle()` function and the same `kind` fallback — a completely separate rendering path from TasksView.
- The two views can show different names, different statuses, and different task counts for the same logical task.

The `paneAgentStatus` store also persists agent state into the layout JSON, creating yet another copy of agent status that can go stale.

## Decision

Make `useTaskStore` the **single source of truth** for all task rendering. Both `TasksView` and `TasksList` will read from the same store and render the same `TaskInfo` objects.

### Changes

#### 1. Enrich `TaskInfo` with live agent fields

Add to `TaskInfo`:
- `agentTitle: string | null` — the cleaned terminal title from the agent (already exists as `AgentState.title`, but needs to flow into the persisted object)

The main process already updates `lastAgentStatus` on every hook event. We'll also update `name` when a meaningful agent title arrives (i.e. not "claude", "claude code", etc.).

#### 2. Update task name from agent title in main process

In the `agentHookServer.setRelay()` callback in `main.ts`, when we receive `agentStatus` events that include a title, update the task's `name` field if it's currently `null` and the title is meaningful (not a generic agent name). This is done via the existing `pty-agent-status` event path — add a listener in the main process that:
- Looks up the task by paneId
- If `task.name` is null and the agent title is non-generic, calls `taskManager.updateTask(task.id, { name: cleanedTitle })` and broadcasts

#### 3. Remove synthetic task creation from TasksView

Delete the merge logic in `TasksView.tsx` (lines 140-175) that creates synthetic `TaskInfo` entries from `useAllAgents()`. The task store already receives tasks as soon as they're created in the main process (which happens on the first active hook event). There should be no meaningful gap where a task exists as a live agent but not as a persisted task.

Remove the `useAllAgents()` import from `TasksView.tsx` entirely.

#### 4. Rewrite TasksList to use task store

Change `TasksList.tsx` to read from `useTaskStore` filtered to `status === "active"`, instead of `useAllAgents()`. It should render `TaskInfo` objects the same way `TasksView` does.

For navigation (clicking a task to jump to its pane), use `task.paneId` + `task.workspacePath` + `task.projectId` to navigate, rather than the `GlobalAgent` object.

#### 5. Remove duplicate `cleanTitle` / `cleanAgentTitle`

Move the title cleaning logic to a shared utility. Use it in the main process when setting `task.name` from agent titles, so the renderer never needs to clean titles itself.

#### 6. Keep `paneAgentStatus` for non-task uses only

`paneAgentStatus` still serves a purpose: `useProjectAgentStatus` and `useSessionAgentStatus` use it to show aggregate status indicators on projects/sessions in the sidebar. These are UI-only concerns (dot colors) that don't need to be in the task store. Keep `paneAgentStatus` for these, but task rendering no longer reads from it.

`TasksView` and `TasksList` get `lastAgentStatus` from the `TaskInfo` object (already populated by the main process on every hook event).

## Consequences

**Better:**
- Single source of truth — task name, status, and metadata are always consistent across all views
- No more "claude" appearing as a task name (the fallback chain is eliminated)
- Simpler components — no merge logic, no synthetic objects, no duplicate cleaning functions
- Task names are set once in the main process and persisted

**Tradeoffs:**
- There may be a brief moment (~100ms) between when a terminal detects an agent process and when the first hook event creates the task. During this window the sidebar won't show the task. This is acceptable — the agent dot on the session tab already provides immediate visual feedback via `paneAgentStatus`.
- `paneAgentStatus` remains for dot/indicator purposes — not fully eliminated, but its scope is narrower and clearly separated from task state.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
