---
title: Add responded status to UI components
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Add responded status to UI components

Update all UI components that display task/agent status to handle the new `"responded"` value.

## AgentDot.tsx
- Add a rendering branch for `status === "responded"` — display a filled dot or small indicator that communicates "agent has a response ready." Use a distinct color (e.g., a blue or teal accent) to differentiate from the green checkmark (complete) and the spinner (working). Could be a simple filled circle with the app's accent color.
- Add corresponding CSS in `AgentDot.module.css` (e.g., `.dotResponded`)

## TasksList.tsx
- Add `responded: "Ready"` to `STATUS_LABEL` map (line 12-18)
- Add `responded` to `STATUS_PRIORITY` between `working` (3) and `complete` (4) — e.g., `responded: 3.5` or renumber: working=3, responded=4, complete=5, idle=6
- The `taskAgentStatus` function (line 29) already passes through `lastAgentStatus` for active tasks, so `"responded"` will flow through naturally

## TasksView.tsx
- Add `responded` handling in `mapTaskStatusToAgentStatus` (line 42) — same as TasksList, active tasks with `lastAgentStatus` already pass through
- No filter changes needed — responded tasks have `status: "active"` so they show under the "Active" filter

## Toast notifications (src/store/task-store.ts)
- Change the toast trigger from `nextStatus === "complete"` to `nextStatus === "responded"` (line 101)
- Update toast message from "Task completed" to "Agent responded" or "Task ready"
- Keep the same success styling and "Go to task" action

## Files to touch
- `src/components/AgentDot.tsx` — Add responded rendering
- `src/components/AgentDot.module.css` — Add `.dotResponded` style
- `src/components/TasksList.tsx` — Add to STATUS_LABEL and STATUS_PRIORITY
- `src/components/TasksView.tsx` — Verify responded flows through (likely no changes needed)
- `src/store/task-store.ts` — Change toast trigger to "responded"
