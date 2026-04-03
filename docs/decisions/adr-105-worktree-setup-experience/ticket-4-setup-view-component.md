---
title: Create WorkspaceSetupView component with checklist and embedded terminal
status: done
priority: high
assignee: opus
blocked_by: [2, 3]
---

# Create WorkspaceSetupView component with checklist and embedded terminal

Build the setup experience UI that renders inside WorkspaceEmptyState, showing a progress checklist and an optional embedded terminal for the setup script.

## Implementation

### 1. Create `src/components/sidebar/WorkspaceSetupView.tsx`

This component renders when `worktreeSetupState[activeWorkspacePath]` exists and `completed` is false.

**Props:**
```typescript
interface WorkspaceSetupViewProps {
  workspacePath: string;
  onComplete: () => void;  // called when fade-out finishes
}
```

**Structure:**
```
<Stack centered>
  <ManorLogo />
  <SetupChecklist steps={steps} />
  {hasStartScript && <MiniTerminalContainer ... />}
</Stack>
```

### 2. SetupChecklist sub-component

Renders each step as a row with:
- **Pending**: Dimmed text, empty circle icon
- **In-progress**: Normal text, animated spinner (CSS animation)
- **Done**: Subtle text, checkmark icon (use lucide-react icons like `Check`, `Loader2`, `Circle`)
- **Error**: Red text, X icon

Step labels (human-readable):
- `prune` → "Pruning stale worktrees"
- `fetch` → "Fetching from remote"
- `create-worktree` → "Creating git worktree" (append message if present, e.g., "on branch feature/foo")
- `persist` → "Saving workspace"
- `switch` → "Switching to workspace"
- `setup-script` → "Running setup script"

### 3. Embedded terminal container

Only rendered when the setup state includes a `setup-script` step:
- A `<div>` container with fixed dimensions (~400×300px), styled with the same terminal background color, rounded corners, subtle border
- Uses the `<MiniTerminal>` component from ticket-3
- `sessionId`: `setup-${workspacePath}`
- `command`: the workspace's `worktreeStartScript`
- `onComplete`: updates the `setup-script` step to `done` in the store

### 4. Fade transition

When all steps are `done`:
1. Mark `completed: true` in the store via `completeWorktreeSetup()`
2. Apply a CSS class that triggers an opacity transition (0.5s ease-out)
3. After the transition ends (`onTransitionEnd`), call `onComplete()` which clears the setup state via `clearWorktreeSetup()`

### 5. Integrate into WorkspaceEmptyState

In `src/components/sidebar/WorkspaceEmptyState.tsx`:
- Read `worktreeSetupState[activeWorkspacePath]` from the app store
- If setup is active and not completed, render `<WorkspaceSetupView>` instead of the normal `<EmptyStateShell>`
- When `onComplete` fires, the setup state is cleared and the normal empty state renders

### 6. CSS Module

Create `src/components/sidebar/WorkspaceSetupView.module.css` for:
- Checklist layout and step row styling
- Step status icon colors and spinner animation
- Terminal container sizing and borders
- Fade-out transition class

## Files to touch
- `src/components/sidebar/WorkspaceSetupView.tsx` — new component
- `src/components/sidebar/WorkspaceSetupView.module.css` — new styles
- `src/components/sidebar/WorkspaceEmptyState.tsx` — conditionally render setup view
