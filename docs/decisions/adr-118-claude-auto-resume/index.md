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

# ADR-118: Auto-Resume Active Claude Sessions After Manor Relaunch

## Context

When Manor relaunches after quitting (or after a crash/update that replaces the daemon), panes that previously had an active Claude session show an empty shell prompt. There is no indication a task was in progress and no auto-resume. Users have to manually re-run Claude in the correct working directory ([orrybaram/manor#116](https://github.com/orrybaram/manor/issues/116)).

`tasks.json` persists enough state to identify these sessions: tasks with `status: "active"`, a known `paneId`, a valid `agentCommand`, and no prior `resumedAt` timestamp.

**What's covered:**
- Session was cold/fresh-restored (daemon replaced or crashed): pane is visible, Claude is not running → auto-resume fires
- Session received a warm restore (same-version restart, Claude still running): `snapshot` is non-null → auto-resume does not fire

**What's out of scope:**
- Tasks with no `agentCommand` stored (tasks created before `agentCommand` was persisted in ADR-066)

## Decision

In `useTerminalLifecycle`, after `create()` resolves for a cold or fresh restore (where `result.snapshot === null` and no pending startup command is queued):

1. Fetch active tasks via the existing `tasks:getAll` IPC with `{ status: "active" }`.
2. Find a task whose `paneId` matches the current pane, `agentCommand` is set, and `resumedAt` is null.
3. Mark the task `resumedAt: <now>` immediately to prevent double-launch on re-mount.
4. Wait for the shell's first CWD event (OSC 7 from precmd hook), then write `agentCommand + "\n"` to the PTY. Fall back to a 3 s timeout if no CWD event arrives (same pattern used for pending startup commands).

The `resumedAt` field is added to `TaskInfo` as a nullable string. It is set on auto-resume and never cleared, so a task only auto-resumes once even if the pane is unmounted and remounted.

### Why renderer-side?

The reconcile result (warm/cold/fresh) is only known in the renderer after `create()` resolves. Putting the auto-resume logic here avoids a new IPC round-trip to communicate restore type back to the main process, and reuses the existing CWD-wait pattern already in `useTerminalLifecycle`.

## Consequences

**Better:**
- After a crash or version upgrade, Claude restarts automatically in the correct pane and CWD without user intervention.
- `resumedAt` provides an audit trail of when auto-resume fired for a given task.

**Neutral:**
- Warm restores (same-version restart, Claude still running) are unaffected — `snapshot` being non-null short-circuits the auto-resume check.
- Prewarmed sessions for new tasks are unaffected — they set `pendingCmd`, which takes priority over auto-resume.

**Limitations:**
- Tasks with `agentCommand: null` (created before that field was stored) cannot be auto-resumed. The user must relaunch manually.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
