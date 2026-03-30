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

# ADR-027: Distinguish "agent responded" from "session closed" task status

## Context

Currently, when an agent finishes its response (the `Stop` hook event), the task immediately transitions to `status: "completed"` with a checkmark indicator. However, "completed" is misleading — the agent has produced a response, but the user hasn't reviewed it or closed the session yet. True completion should mean the user has acknowledged the result and closed the session (`SessionEnd` event).

Today's status flow:
- `active` (thinking/working/requires_input) → `completed` (on `Stop`) → `completed` (on `SessionEnd`)

There's no way for the user to distinguish "agent is done talking, go review it" from "I reviewed it and closed the session."

## Decision

Introduce a new `AgentStatus` value `"responded"` and a corresponding visual indicator, creating a three-phase completion model:

### Status model

| Event | `TaskStatus` | `AgentStatus` | UI indicator |
|-------|-------------|---------------|--------------|
| Agent working | `active` | `thinking`/`working` | Spinner |
| Agent finished response (`Stop`) | `active` | `responded` | New "responded" indicator (filled dot or similar) |
| User closed session (`SessionEnd`) | `completed` | `complete` | Checkmark |

### Changes by layer

**1. Types** (`electron/terminal-host/types.ts`, `src/electron.d.ts`)
- Add `"responded"` to `AgentStatus` type

**2. Hook mapping** (`electron/agent-hooks.ts`)
- Map `Stop` event → `"responded"` instead of `"complete"`
- `SessionEnd` continues to map to `"idle"` (but the task status transition in `main.ts` handles the real completion)

**3. Task lifecycle** (`electron/main.ts`)
- On `Stop` event: set `lastAgentStatus: "responded"`, keep `status: "active"` (don't transition to `"completed"` yet)
- On `SessionEnd` event: set `lastAgentStatus: "complete"`, `status: "completed"`, `completedAt`
- Subagent completion logic: when parent is `responded` and last subagent finishes, stay `active`/`responded` (don't auto-complete)

**4. UI components**
- `AgentDot.tsx`: Add rendering for `"responded"` — a distinct visual (e.g., filled circle with a subtle color, or a small chat-bubble icon) that communicates "has a response ready"
- `TasksList.tsx`: Add `"responded"` to `STATUS_LABEL` (label: "Ready" or "Responded"), add to `STATUS_PRIORITY` (between `working` and `complete`)
- `TasksView.tsx`: `mapTaskStatusToAgentStatus` — for `active` tasks with `lastAgentStatus === "responded"`, show the responded indicator
- `TasksView.tsx`: Filter logic — "Active" filter should include responded tasks (they're still `status: "active"`)

**5. Toast notifications** (`src/store/task-store.ts`)
- Change the existing `"complete"` toast trigger to fire on `"responded"` instead — the user still wants to know the agent finished
- Message could be "Task ready" or "Agent responded" instead of "Task completed"

## Consequences

**Better:**
- Users can distinguish "needs my attention" from "fully closed out" at a glance
- Sidebar task list becomes more informative — responded tasks invite review, completed tasks are truly done
- The "Completed" filter in TasksView becomes more meaningful (only closed sessions)

**Tradeoffs:**
- One more status to reason about in the UI
- Responded tasks stay in the sidebar "active" list longer (until session close) — this is actually desirable since it nudges users to review

**Risks:**
- Need to handle the migration path: existing `completed` tasks in the DB were set on `Stop`, not `SessionEnd`. These are fine as-is since they represent historical tasks.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
