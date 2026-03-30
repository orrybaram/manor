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

# ADR-018: Task Persistence System

## Context

Manor detects Claude/AI agents running in terminal panes via hook events but only tracks them transiently in the Zustand `paneAgentStatus` map. When a session ends or Manor restarts, all agent history is lost. The sidebar's `WorkspaceAgentList` (in `ProjectItem.tsx`) shows live agents but provides no history.

Users need to:
- Track every Claude session that has ever been created
- Browse historical tasks grouped by date and project
- Resume any past session with a click via `claude --resume <session-id>`

Claude Code's hook system sends JSON on stdin that includes `session_id`, `cwd`, and `transcript_path`, but the current hook script (`~/.manor/hooks/notify.sh`) only extracts `hook_event_name`. The `session_id` is the key needed for `--resume`.

## Decision

### Data Model

A new `TaskInfo` entity stored as a first-class entity alongside projects:

```typescript
interface TaskInfo {
  id: string;                    // crypto.randomUUID()
  claudeSessionId: string;       // from hook JSON "session_id"
  name: string | null;           // from agent title (cleaned OSC title)
  status: "active" | "completed" | "error" | "abandoned";
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  completedAt: string | null;    // ISO timestamp
  projectId: string | null;      // Manor project ID
  projectName: string | null;    // denormalized for display
  workspacePath: string | null;  // workspace path where task ran
  cwd: string;                   // working directory
  agentKind: AgentKind;          // "claude" | "opencode" | "codex"
  paneId: string | null;         // if currently attached to a terminal pane
  lastAgentStatus: AgentStatus | null;
}
```

### Storage

JSON file at `~/Library/Application Support/Manor/tasks.json`, following the `projects.json` pattern from `electron/persistence.ts`. A `TaskManager` class handles CRUD with an in-memory `Map<claudeSessionId, TaskInfo>` for O(1) lookups. Debounced saves (500ms) prevent excessive disk writes during rapid hook events.

The interface is designed so a SQLite migration later only changes the implementation, not the API.

### Hook Enhancement

The hook script is updated to also extract `session_id` from the Claude hook JSON and pass it to the `AgentHookServer` HTTP endpoint. The relay function gains a `sessionId` parameter.

### Task Lifecycle

- **Creation**: On the first hook event for a new `sessionId`, the main process creates a task using the pane's workspace context (resolved via a `paneId -> workspace` mapping maintained in main)
- **Updates**: Each hook event updates `lastAgentStatus`, `updatedAt`, and `name` (from agent title)
- **Completion**: `Stop` -> "completed", `StopFailure` -> "error", `SessionEnd` -> "completed"
- **Real-time push**: Task updates are pushed to the renderer via IPC `task-updated` channel

### Pane-to-Workspace Mapping

The main process maintains a `Map<paneId, { projectId, projectName, workspacePath }>`. The renderer calls `tasks:setPaneContext` after creating a PTY so the main process can associate hook events with the correct project.

### Main Content List View

A new `TasksView` component replaces the terminal area when the user navigates to the tasks view:
- Groups by date (Today, Yesterday, This Week, This Month, Older) then by project
- Each row: status dot, task name, project badge, timestamp
- Click resumes: switches to workspace, creates new session, writes `claude --resume <sessionId>\r`
- Pagination: 50 tasks per page with "Load more"

### Navigation

- `App.tsx` gains a `viewMode: "terminal" | "tasks"` state
- Sidebar gets a "Tasks" section link to switch to the tasks view
- Clicking a task switches back to terminal mode

## Consequences

**Benefits:**
- Full audit trail of every Claude session with metadata
- One-click resume for any historical session
- Tasks become a first-class entity like projects/workspaces
- Real-time status tracking via existing hook infrastructure

**Tradeoffs:**
- JSON file will grow over time (thousands of tasks) — acceptable for now, SQLite migration path exists
- Denormalized `projectName` means stale names if project is renamed (minor)
- Hook script update requires Manor restart to take effect (already the case for hook changes)

**Risks:**
- Hook events may arrive before the renderer sends pane context — tasks created without project association. Mitigated by deferred association on the next hook event after context arrives.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
