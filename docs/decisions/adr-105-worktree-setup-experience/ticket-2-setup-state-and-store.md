---
title: Add worktree setup state to app store and update createWorktree flow
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Add worktree setup state to app store and update createWorktree flow

Add setup progress tracking to the app store and modify the `createWorktree` store action to use progress events instead of the pending startup command pattern.

## Implementation

### 1. Add types and state to app-store.ts

Add to the store state in `src/store/app-store.ts`:

```typescript
type SetupStep = "prune" | "fetch" | "create-worktree" | "persist" | "switch" | "setup-script";
type StepStatus = "pending" | "in-progress" | "done" | "error";

interface SetupStepState {
  step: SetupStep;
  status: StepStatus;
  message?: string;
}

interface WorktreeSetupState {
  steps: SetupStepState[];
  completed: boolean;
  startScript?: string | null;
  workspacePath?: string;
}

// In the store state:
worktreeSetupState: Record<string, WorktreeSetupState>;
```

Add actions:
- `initWorktreeSetup(wsPath: string, hasStartScript: boolean): void` — creates the initial state with all git steps as pending, plus setup-script step if applicable
- `updateWorktreeSetupStep(wsPath: string, step: SetupStep, status: StepStatus, message?: string): void` — updates a single step
- `completeWorktreeSetup(wsPath: string): void` — sets `completed: true`
- `clearWorktreeSetup(wsPath: string): void` — removes the entry

### 2. Modify createWorktree in project-store.ts

Update `createWorktree` (lines 289-348 in `src/store/project-store.ts`):

1. Before the IPC call, determine if a start script exists by looking at the project's `worktreeStartScript` setting. Initialize setup state via `useAppStore.getState().initWorktreeSetup()`.

2. Subscribe to progress events from the preload API (`window.electronAPI.projects.onWorktreeSetupProgress`) before calling `createWorktree` IPC. Each progress event updates the store via `updateWorktreeSetupStep()`.

3. After IPC completes successfully, emit the `switch` step as `in-progress`, do `selectWorkspace()`, then mark `switch` as `done`.

4. **Key change:** If `worktreeStartScript` exists, do NOT call `setPendingStartupCommand()` or `addSession()`. Instead, store the script command in the setup state so the setup view can read it. The setup view's embedded terminal will handle execution.

5. If there's only an `agentCommand` (no start script), continue using the existing `setPendingStartupCommand` + `addSession` pattern — the setup checklist will still show but without an embedded terminal.

6. Unsubscribe from progress events after IPC completes.

## Files to touch
- `src/store/app-store.ts` — add `worktreeSetupState` field, init/update/complete/clear actions
- `src/store/project-store.ts` — modify `createWorktree` to init setup state, subscribe to progress events, skip `addSession` for setup scripts
