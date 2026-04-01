---
type: adr
status: proposed
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

# ADR-105: Worktree Setup Experience

## Context

When a user creates a new worktree workspace, the app currently:
1. Makes a single IPC call (`projects:createWorktree`) that does multiple git operations invisibly
2. Switches to the new workspace showing `WorkspaceEmptyState`
3. Launches the setup script (if configured) as a separate full terminal tab

The user has zero visibility into what's happening during creation. The setup script runs in a regular session tab that persists in the layout.

## Decision

Replace the invisible creation flow with a **setup experience** rendered inside `WorkspaceEmptyState`:

### 1. Progress Events from Backend

Break the single `projects:createWorktree` IPC call into a flow that emits progress events. Rather than splitting into multiple IPC calls (which would complicate error handling and atomicity), the backend will emit progress events via `BrowserWindow.webContents.send()` on a `worktree:setup-progress` channel while the existing `createWorktree` method runs. The renderer subscribes to these events before initiating creation.

Progress event shape:
```typescript
type SetupStep = "prune" | "fetch" | "create-worktree" | "persist" | "switch" | "setup-script";
type StepStatus = "pending" | "in-progress" | "done" | "error";
type SetupProgressEvent = { step: SetupStep; status: StepStatus; message?: string };
```

Steps emitted:
- `prune` — Pruning stale worktrees
- `fetch` — Fetching from remote
- `create-worktree` — Creating git worktree (+ branch strategy info in message)
- `persist` — Persisting workspace metadata
- `switch` — Switching to workspace

The `setup-script` step is handled entirely on the renderer side (see below).

### 2. Setup State in App Store

Add a `worktreeSetupState` field to the app store keyed by workspace path:

```typescript
worktreeSetupState: Record<string, {
  steps: Array<{ step: SetupStep; status: StepStatus; message?: string }>;
  completed: boolean;
}>;
```

The `createWorktree` store action will:
1. Initialize setup state with all steps as `pending` before calling IPC
2. Subscribe to `worktree:setup-progress` events and update step statuses
3. After IPC completes, mark git steps as done
4. If a startup script exists, add the `setup-script` step as `in-progress`
5. Instead of calling `addSession()` for the startup script, set a flag indicating the embedded terminal should run it

### 3. WorkspaceSetupView Component

A new sub-component of `WorkspaceEmptyState` that renders when `worktreeSetupState` exists for the active workspace path and `completed` is false.

**Checklist UI:** Renders each step with status indicators:
- Pending: dimmed text
- In-progress: spinner icon
- Done: checkmark icon
- Error: error icon (future work for retry)

**Embedded Terminal:** If `worktreeStartScript` is configured:
- Renders a small xterm terminal (~400px wide, ~300px tall) below the checklist
- Creates an ephemeral PTY session using a unique ID like `setup-${workspacePath}` — NOT tracked in the workspace's session/layout state
- The PTY is created via the same `pty:create` / `pty:write` IPC as regular terminals
- The setup script is written to the PTY after shell init
- Terminal is non-interactive (no `onData` handler wired to write)
- Auto-scrolls output
- When the script completes (detected via PTY exit or process completion), marks the `setup-script` step as done and kills the PTY session

**Transition:** Once all steps are `done`, the setup view fades out (CSS opacity transition ~500ms) and unmounts, revealing the normal `WorkspaceEmptyState` content underneath.

### 4. Shared MiniTerminal Component (extracted from GitHubNudge)

`GitHubNudge.tsx` already implements an ephemeral terminal pattern (dynamic xterm import, PTY creation, output subscription, exit detection, cleanup). Extract this into a reusable `useMiniTerminal` hook + `<MiniTerminal>` component, then refactor GitHubNudge to use it.

The component supports:
- `interactive` mode (for GitHubNudge's `gh auth login`) or read-only mode (for setup scripts)
- `onOutput` callback for pattern matching (GitHubNudge's auth detection)
- `onExit` callback for completion detection
- Automatic PTY cleanup on unmount (kill, not detach)

### 5. Flow Changes

**Before (current):**
```
Dialog submit → IPC createWorktree → update store → selectWorkspace → setPendingStartupCommand → addSession()
```

**After:**
```
Dialog submit → initSetupState → IPC createWorktree (with progress events) → selectWorkspace → WorkspaceEmptyState renders SetupView → embedded terminal runs script → fade to normal empty state
```

Key change: `createWorktree` no longer calls `addSession()` or `setPendingStartupCommand()` when a setup script exists. Instead, the setup view handles script execution in its embedded terminal.

## Consequences

**Better:**
- Users see real-time progress during worktree creation
- Setup script output is visible inline instead of in a separate tab
- No leftover terminal tab from the setup script
- Smoother transition into the workspace

**Harder:**
- More complex state management for the setup flow
- Backend needs to emit granular progress events
- New ephemeral terminal pattern that doesn't exist yet

**Risks:**
- PTY cleanup must be bulletproof — a leaked ephemeral session would be confusing
- Progress events must be correctly ordered; race conditions between IPC response and event delivery need handling

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
