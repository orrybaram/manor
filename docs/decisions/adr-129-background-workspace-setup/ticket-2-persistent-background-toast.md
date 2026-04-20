---
title: Persistent toast when setup is running in the background
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Persistent toast when setup is running in the background

Ticket 1 decouples the setup-script PTY from the view. This ticket adds the UX affordance: a persistent toast so the user knows the setup is still running when they navigate away from the setup view.

## Behavior

- **Show**: When `WorkspaceSetupView` unmounts while the setup-script step is still in progress (i.e. not `done`/`error` and the view is not in its fade-out success transition), emit a persistent loading toast.
- **Remove on return**: If the user navigates back to the setup view before completion, dismiss the toast as the view re-mounts.
- **Remove on completion**: Ticket 1's orchestrator already calls `removeToast(\`worktree-setup-${wsPath}\`)` on PTY exit and then emits the "Workspace setup complete" success toast — no extra work needed here for the happy path.
- **No duplicates**: The toast `id` is deterministic (`worktree-setup-${wsPath}`), so re-adding replaces rather than stacking (see toast-store `addToast` dedupe at src/store/toast-store.ts:25-32).

## Toast shape

```ts
{
  id: `worktree-setup-${wsPath}`,
  message: `Setting up "${wsName}"…`,
  status: "loading",
  persistent: true,
}
```

Resolve `wsName` from the workspace if possible:

- If `wsPath !== "__pending__"`, find the workspace in `useProjectStore.getState().projects` (iterate projects, find workspace by `path === wsPath`) and use its `name || branch || path.split("/").pop()`.
- If `wsPath === "__pending__"` (the orchestrator runs after the path is known, so this case should not occur in practice for the background toast — the view only unmounts after the workspace exists), fall back to `"workspace"`.

Keep the resolution logic in a small local helper; do not export it.

## Implementation

### 1. Emit on unmount-while-running

In `src/components/sidebar/WorkspaceSetupView.tsx`, add a `useEffect` whose cleanup runs on unmount and inspects the latest store state to decide whether to emit. Shape:

```ts
useEffect(() => {
  return () => {
    const latest = useAppStore.getState().worktreeSetupState[workspacePath];
    if (!latest || latest.completed) return;
    const setupScriptStep = latest.steps.find((s) => s.step === "setup-script");
    const stillRunning =
      setupScriptStep &&
      (setupScriptStep.status === "in-progress" || setupScriptStep.status === "pending");
    if (!stillRunning) return;
    const wsName = resolveWorkspaceName(workspacePath);
    useToastStore.getState().addToast({
      id: `worktree-setup-${workspacePath}`,
      message: `Setting up "${wsName}"…`,
      status: "loading",
      persistent: true,
    });
  };
}, [workspacePath]);
```

Read state inside the cleanup (via `getState()`), not from a subscribed selector — the cleanup needs the *final* state at unmount time, not the state as of the last render.

Important: this effect must guard against the "fade-out transition" case. `WorkspaceEmptyState` triggers unmount by flipping `phase` from `setup` → `transitioning` only after `allDone` is true (see WorkspaceSetupView.tsx:96, 119-123 and WorkspaceEmptyState.tsx:350-359 pre-ticket-1). So the `completed` flag is the correct signal — if `completed: true`, no toast; if `completed: false` and setup-script step isn't done/error, show toast.

### 2. Clear on mount

Also in `WorkspaceSetupView`, add a `useEffect` that fires on mount to remove any existing background toast for this workspace:

```ts
useEffect(() => {
  useToastStore.getState().removeToast(`worktree-setup-${workspacePath}`);
}, [workspacePath]);
```

This covers the "user navigated away and came back" case. `removeToast` is a no-op if the id isn't present, so this is safe when there was no background toast.

### 3. Confirm orchestrator removes the toast on completion

Ticket 1 already includes `useToastStore.getState().removeToast(\`worktree-setup-${wsPath}\`)` in `startSetupScript`'s exit handler. Verify it's there; if ticket 1 missed it, add it as part of this ticket — but it is specified in ticket 1 and should already be present.

## Files to touch

- `src/components/sidebar/WorkspaceSetupView.tsx` — add mount effect (clear toast) and unmount effect (emit toast if still running); add `resolveWorkspaceName` local helper.

No other files should need changes.

## Verification

- `bun run typecheck` and `bun run build`.
- Manual smoke (document for the reviewer): start a workspace setup with a long-running setup script, navigate to another workspace mid-script — toast appears with the workspace name and loading spinner. Navigate back — toast disappears and MiniTerminal resumes showing output. Let setup complete while backgrounded — toast disappears and success toast ("Workspace setup complete") fires.
