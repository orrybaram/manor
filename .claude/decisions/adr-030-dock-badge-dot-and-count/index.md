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

# ADR-030: Dock badge — dot for responses, count for input needed

## Context

The current dock badge system (ADR-028) shows a numeric count of all tasks with `lastAgentStatus === "responded"`. The badge clears entirely when the app window gains focus, regardless of whether the user has actually looked at the tasks.

The user wants a more nuanced system:
- **"Has response"** (responded) → show a dot indicator, no count
- **"Needs user input"** (requires_input) → show a numeric count
- Badge count should decrement when the user navigates to the specific task needing input
- Badge dot should clear only when the user has seen all tasks with responses

This requires tracking which tasks the user has "seen" rather than just clearing on focus.

## Decision

### Main process changes (`electron/main.ts`)

1. **Track unseen tasks**: Maintain two `Set<string>` collections in the main process (in-memory, not persisted):
   - `unseenRespondedTasks` — task IDs that transitioned to "responded" but haven't been seen
   - `unseenInputTasks` — task IDs that transitioned to "requires_input" but haven't been navigated to

2. **Update badge logic**: `updateDockBadge()` changes from counting responded tasks to:
   - If `unseenInputTasks.size > 0` → show count (e.g. "2")
   - Else if `unseenRespondedTasks.size > 0` → show dot ("●")
   - Else → clear badge

3. **Add to unseen sets**: When a task transitions to "responded" or "requires_input" (in the relay handler), add its ID to the corresponding unseen set.

4. **New IPC handler**: `tasks:markSeen(taskId)` — removes the task ID from both unseen sets and updates the badge. Called by the renderer when the user navigates to a task.

5. **Remove focus-clear**: Remove the `mainWindow.on("focus")` handler that blanket-clears the badge. The badge should only clear based on actual task acknowledgment.

6. **Clean up on task removal**: When a task is deleted or its status changes away from active, remove it from the unseen sets.

### Preload changes (`electron/preload.ts`)

Add `markSeen: (taskId: string) => ipcRenderer.invoke("tasks:markSeen", taskId)` to the tasks API.

### Type changes (`src/electron.d.ts`)

Add `markSeen` to the tasks interface in `ElectronAPI`.

### Renderer changes (`src/store/task-store.ts`)

- In `navigateToTask` calls (notification click handler), also call `window.electronAPI.tasks.markSeen(taskId)`.
- In `receiveTaskUpdate`, when a task update arrives and the task's pane is already visible in the active session, auto-mark it as seen.

### Renderer changes (`src/utils/task-navigation.ts`)

- After navigating to a task, call `window.electronAPI.tasks.markSeen(task.id)` to acknowledge it.

## Consequences

- **Better UX**: Users get distinct visual signals — a dot means "something finished, check when convenient" vs a count means "N tasks are blocked waiting for you"
- **No more premature clearing**: Badge persists until the user actually views the relevant task, not just focuses the window
- **In-memory tracking**: Unseen sets are not persisted, so restarting the app clears them. This is acceptable since the badge is a transient notification mechanism.
- **Combined badge limitation**: macOS dock badge is a single string, so when both responded and requires_input tasks exist, the numeric count takes priority (it's more urgent). The dot only shows when there are no pending input tasks.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
