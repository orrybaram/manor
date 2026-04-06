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

# ADR-113: Unified Task System — Merge Live Pane State with Persisted Tasks

## Context

The app currently has two parallel systems tracking agent activity:

1. **Live pane state** (`paneAgentStatus`, `paneTitle` in app-store) — updated in real-time via PTY daemon stream events. This is what tabs display (title + status dot).
2. **Persisted task state** (`TaskInfo` via `TaskManager`) — updated via agent hook HTTP callbacks. This is what the sidebar TasksList displays.

These systems are disconnected:

- **Title mismatch:** Tab titles update live from terminal OSC sequences. Task names are set *once* from `cleanAgentTitle()` when the first non-generic agent title arrives (`app-lifecycle.ts:137`: `if (task && !task.name)`). After that, the task name is frozen even as the agent's title evolves (e.g., "Reduce padding in two..." appears in the tab but the task list shows the stale first title).
- **Status divergence:** Tabs show `paneAgentStatus[paneId].status` (live from daemon). The task list shows `task.lastAgentStatus` (from hook events). These arrive at different times via different paths, so the task list can lag behind or show different states than the tab.
- **No live fallback:** The `TasksList` component has no way to read live pane status — it only reads from the persisted `TaskInfo` object. Even when a task's pane is right there with fresh data, the task list ignores it.

The user wants a single unified system where the task is the source of truth, fed by *both* hook events and live PTY stream data, whichever is more current.

## Decision

### 1. Keep task name continuously updated

**In `app-lifecycle.ts`** (the `agentStatus` stream event handler, line 133-151):
- Remove the `!task.name` guard so task names update on every meaningful agent title change.
- Only update when the cleaned title is different from the current `task.name` to avoid unnecessary broadcasts.

This means the persisted task name stays in sync with what the agent is currently reporting as its title.

### 2. Feed live pane title into task display (renderer-side)

**In `TasksList.tsx` and `TasksView.tsx`:**
- For active tasks with a live pane, derive the display title from `paneTitle[task.paneId]` (the same source tabs use), cleaned via the same `cleanAgentTitle()` logic.
- Fall back to `task.name` when no live pane title is available (pane closed, task completed, etc.).
- Extract `cleanAgentTitle` into a shared utility (`src/utils/agent-title.ts`) so both main and renderer can use the same cleaning logic.

### 3. Feed live pane status into task display (renderer-side)

**In `TasksList.tsx` and `TasksView.tsx`:**
- For active tasks with a live pane, derive status from `paneAgentStatus[task.paneId]` instead of `task.lastAgentStatus`.
- Fall back to `task.lastAgentStatus` when no live pane status exists.
- This means the `taskAgentStatus()` function checks live state first, persisted state second.

### 4. Create a `useTaskDisplay` hook

Centralize the "what title and status should this task show?" logic in a single hook:

```typescript
function useTaskDisplay(task: TaskInfo): { title: string; status: AgentStatus } {
  const liveStatus = useAppStore(s => task.paneId ? s.paneAgentStatus[task.paneId] : null);
  const liveTitle = useAppStore(s => task.paneId ? s.paneTitle[task.paneId] : null);

  const title = (liveTitle ? cleanAgentTitle(liveTitle) : null) ?? task.name ?? "Agent";
  const status = deriveStatus(task, liveStatus);

  return { title, status };
}
```

Both `TasksList` and `TasksView` use this hook, eliminating the duplicated `taskAgentStatus()` functions that currently exist in both files (and `useTaskCommands.tsx`).

## Consequences

**Better:**
- Task list titles match tab titles — no more stale "Agent" labels while tabs show the real title.
- Task list status matches tab status in real-time — "working" shows when the agent is working, not seconds later.
- Single source of display logic via `useTaskDisplay` hook — no more duplicated status mapping.
- Persisted task names still update (for when pane is closed and we need the last known title).

**Risks:**
- `cleanAgentTitle` needs to be extracted to a shared module usable in both Electron main and renderer. It's currently in `electron/title-utils.ts` (main-only). We'll create a copy in `src/utils/agent-title.ts` for the renderer since the function is pure and simple (no shared module system between main/renderer in this codebase).
- Live title from terminal OSC may include SSH-style prefixes (`user@host:/path`). The `useTabTitle` hook already strips these. We need to apply similar cleaning in `useTaskDisplay`, or reuse `useTabTitle`'s parsing logic. Decision: apply `cleanAgentTitle` first, then strip SSH prefix if present.

**No change:**
- Hook-driven task lifecycle (creation, completion, subagent tracking) stays as-is — it works correctly.
- Task persistence format unchanged.
- Tab display logic unchanged — tabs already show live data.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
