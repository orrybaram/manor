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

# ADR-019: Fix Task Status Lifecycle (Spurious Tasks & Subagent Tracking)

## Context

The task persistence system (ADR-018) has two bugs in how it handles agent lifecycle events, plus a noisy error in process detection:

**Bug 1: Phantom tasks on session start.** When a new Claude session launches, a "Stop" hook event can fire during CLI initialization (before the agent does any real work). The current relay callback in `main.ts` (lines 708-757) creates a new task on the first hook event with a `sessionId`, then immediately marks it "completed" when the "Stop" event arrives. This produces a task entry that appears with status "done" before any work has been performed.

The `AgentDetector` already has a guard for this — the `hasBeenActive` flag (line 47, 174-183) which drops "complete"/"error" events if the agent was never active. However, the task persistence relay in `main.ts` does **not** use this guard. It blindly maps "Stop" → "complete" → task status "completed" regardless of whether any real work was done.

**Bug 2: Premature completion when subagents are running.** When Claude spawns subagents (via the Agent tool), the parent session fires a "Stop" hook when it finishes its own turn — even though subagents are still doing work. The current code maps this "Stop" directly to task status "completed". Subsequent "SubagentStart"/"SubagentStop" events update `lastAgentStatus` but never transition the task back to "active" because the status update logic (lines 731-740) only handles transitions *to* terminal states, never *from* them.

The root issue: the relay callback has no concept of subagent depth. It should only mark a task as completed when the parent stops AND there are zero active subagents.

**Bug 3: Noisy `ps` command errors in process detection.** The `detectAgentFromChildArgs()` function in `pty-subprocess.ts` runs `ps -o args= -p PID1 -p PID2` with a 200ms timeout. When child processes exit between the `pgrep` and `ps` calls (common race condition), the command either fails on dead PIDs or exceeds the timeout and gets SIGTERM-killed. These errors are logged via `console.error`, flooding stderr with stack traces. This is expected behavior during rapid process turnover, not a real error.

## Decision

### Fix 1: Gate task creation and completion on activity

Add a `hasBeenActive` check to the task persistence relay, mirroring the guard already present in `AgentDetector`:

- When the first hook event arrives for a new sessionId, **do not create a task** if the status is a terminal state ("complete", "error", "idle"). Only create tasks when the agent first becomes active ("thinking", "working", "requires_input").
- When updating an existing task, only transition to "completed" if the task has previously been in an active state. This means checking that the task was created with status "active" (which it always is) AND that it received at least one non-terminal status update before the terminal one.

Implementation: track an `activatedAt` timestamp on `TaskInfo`. Set it on the first "thinking"/"working"/"requires_input" event. Only allow transition to "completed" when `activatedAt` is non-null.

### Fix 2: Track subagent depth to defer completion

Add a `subagentCount` field to `TaskInfo` (in-memory only, not persisted — subagent state doesn't survive app restarts). The relay callback updates it:

- On "SubagentStart" → increment `subagentCount`, ensure task status is "active"
- On "SubagentStop" → decrement `subagentCount` (floor at 0)
- On "Stop" (parent complete): if `subagentCount > 0`, set `lastAgentStatus` to "complete" but keep task status as "active". Store a flag `parentComplete = true`.
- When `subagentCount` reaches 0 AND `parentComplete` is true, *then* transition task to "completed".

This in-memory tracking lives in the relay closure in `main.ts`, not in `TaskInfo` persistence, since subagent state is inherently ephemeral.

### Files to change

1. **`electron/main.ts`** — Refactor the relay callback closure to:
   - Maintain a `Map<sessionId, { subagentCount, parentComplete, hasBeenActive }>` for in-flight session state
   - Gate task creation on first active event
   - Gate task completion on subagent count reaching zero
   - Clean up map entries when task reaches terminal state

2. **`electron/agent-hooks.ts`** — No changes needed. The hook event mapping is correct; the issue is purely in how the relay interprets the mapped statuses.

3. **`electron/task-persistence.ts`** — Add `activatedAt: string | null` field to `TaskInfo`. This is persisted so that on app restart, tasks that were never activated can be identified and cleaned up.

4. **`src/electron.d.ts`** — Update `TaskInfo` type to include `activatedAt`.

## Consequences

**Positive:**
- No more phantom "done" tasks appearing on session start
- Tasks stay active while subagents are running, giving accurate status in the TasksView
- The fix is localized to the relay callback — no changes to the hook server, agent detector, or UI components

**Negative:**
- In-memory subagent tracking is lost on app restart. If the app crashes while subagents are running, those tasks will remain "active" forever. This is acceptable — the existing stale-task problem already exists and can be addressed separately with a cleanup sweep.
- Adds slight complexity to the relay callback. However, this replaces the current naive mapping with correct lifecycle tracking.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
