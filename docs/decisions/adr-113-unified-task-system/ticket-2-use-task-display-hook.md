---
title: Create useTaskDisplay hook for unified title and status
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Create useTaskDisplay hook for unified title and status

Create a centralized hook that derives the display title and status for a task, preferring live pane data when available and falling back to persisted task data.

## What to do

1. Create `src/hooks/useTaskDisplay.ts` with:

```typescript
import { useAppStore } from "../store/app-store";
import { cleanAgentTitle } from "../utils/agent-title";
import type { AgentStatus, TaskInfo } from "../electron.d";

export function useTaskDisplay(task: TaskInfo): { title: string; status: AgentStatus | undefined } {
  // Read live pane state when task has an active pane
  const liveAgent = useAppStore((s) =>
    task.paneId ? (s.paneAgentStatus[task.paneId] ?? null) : null,
  );
  const liveTitle = useAppStore((s) =>
    task.paneId ? (s.paneTitle[task.paneId] ?? null) : null,
  );

  // Title: prefer live pane title (cleaned), fall back to persisted task name
  const cleanedLive = liveTitle ? cleanLiveTitle(liveTitle) : null;
  const title = cleanedLive ?? task.name ?? "Agent";

  // Status: prefer live pane status for active tasks, fall back to persisted
  const status = deriveStatus(task, liveAgent);

  return { title, status };
}
```

2. `cleanLiveTitle(raw: string): string | null` — helper that:
   - Strips SSH-style prefix (`user@host:/path` → last path segment) — same logic as `useTabTitle.ts` line 40-44
   - Then runs `cleanAgentTitle()` on the result
   - Returns null if result is null/empty or is just a directory name (we only want agent task titles, not CWD-derived names)

   **Important nuance:** Terminal titles can be either agent task descriptions ("Reduce padding in two...") or CWD paths ("user@mac:~/Code/project"). We want agent titles, not paths. Heuristic: if the title matches the SSH pattern `/.+@.+:.+/`, it's a CWD title — skip it (return null, let task.name be used). Otherwise, clean it with `cleanAgentTitle()`.

3. `deriveStatus(task: TaskInfo, liveAgent: AgentState | null): AgentStatus | undefined` — helper that:
   - If task is active AND `liveAgent` exists with a non-idle status → return `liveAgent.status`
   - Else if task is active AND `task.lastAgentStatus` → return `task.lastAgentStatus as AgentStatus`
   - Else → map `task.status` to AgentStatus: `{ active: "working", completed: "complete", error: "error", abandoned: "idle" }`

4. Export `useTaskDisplay` as the single public API.

## Files to touch
- `src/hooks/useTaskDisplay.ts` — **create** hook with `useTaskDisplay`, `cleanLiveTitle`, `deriveStatus`
