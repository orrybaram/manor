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

# ADR-031: Stop pulse animation on seen/active-tab tasks

## Context

The green pulsing notification dot in the tasks sidebar always pulses when a task has `responded` status, even if the user is currently looking at that task's tab or has already seen the response. This makes the pulse meaningless as a "new response" indicator — it becomes visual noise.

ADR-030 added unseen tracking in the main process for dock badge purposes. The renderer needs similar awareness so the sidebar dot can stop pulsing when:
1. The user is on the tab containing the task
2. The user has already clicked on/seen the task

## Decision

### 1. Add `pulse` prop to `AgentDot` component

Add an optional `pulse?: boolean` prop (default `true`). When `false` and status is `responded`, render the green dot without the pulse/ping animations. Add a `.dotRespondedStatic` CSS class for this.

### 2. Track seen tasks in the renderer

Add a `seenTaskIds: Set<string>` to the task store. Mark a task as seen when:
- The user clicks on it (navigateToTask already calls markSeen in main)
- The task's pane is already visible when the status transitions to "responded"

Clear the seen flag for a task when it transitions away from "responded" (so a new response pulses again).

### 3. Wire it up in TasksList

In `TasksList`, for each task determine `shouldPulse`:
- `false` if the task's pane is the focused pane in the active session
- `false` if the task ID is in `seenTaskIds`
- `true` otherwise

Pass `pulse={shouldPulse}` to `<AgentDot>`.

## Consequences

- Pulse becomes a meaningful "unread" indicator rather than a permanent animation
- Minimal changes: 3 files touched, no new IPC needed (seen state is renderer-only for sidebar; main process already handles dock badge)
- The seen set is in-memory only — refreshing clears it, which is fine since pulse is a transient indicator

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
