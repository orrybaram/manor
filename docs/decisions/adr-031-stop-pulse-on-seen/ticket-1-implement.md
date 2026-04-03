---
title: Stop pulse on seen/active-tab tasks
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Stop pulse on seen/active-tab tasks

Implement all three parts of the decision: AgentDot pulse prop, renderer seen tracking, and TasksList wiring.

## Files to touch
- `src/components/AgentDot.tsx` — add optional `pulse` prop
- `src/components/AgentDot.module.css` — add `.dotRespondedStatic` class (green dot, no animation)
- `src/store/task-store.ts` — add `seenTaskIds` Set, mark seen on visibility/navigation, clear on status change
- `src/components/TasksList.tsx` — compute `shouldPulse` per task, pass to AgentDot
