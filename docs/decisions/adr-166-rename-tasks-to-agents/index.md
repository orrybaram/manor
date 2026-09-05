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

# ADR-166: Rename the "Task" concept to "Agent"

## Context

Manor's persisted lifecycle record for an agent CLI session (Claude Code,
Codex, Pi) running in a pane was called a **Task** — `TaskInfo`,
`TaskManager`, `tasks:*` IPC, `GET /tasks`, the `list_tasks` MCP tool, the
sidebar "Tasks" list and the "New Task" command. Users and the UI talk about
"agents", and the word "task" collided with unrelated meanings (subagent
tasks inside the agent, background tasks). The product decision is to call
the record what it represents: an **Agent**.

The rename collides with an existing, narrower use of "agent" for the live
CLI process: `AgentState`, `AgentStatus`, `AgentDetector`, `routes/agents.ts`
(`POST /agents` launch), `mcp/tools-agents.ts`, and the `agent` local used
alongside `task` in the status hooks.

## Decision

Rename the concept everywhere in the codebase and UI, with these resolutions
for the collisions:

- `TaskInfo` → `AgentInfo`, `TaskManager` → `AgentManager`, `task-persistence.ts`
  → `agent-persistence.ts`, `ipc/tasks.ts` → `ipc/agents.ts`,
  `store/task-store.ts` → `store/agent-store.ts`, `TasksList`/`TasksView` →
  `AgentsList`/`AgentsView`, `useTaskDisplay`/`useTaskCommands` →
  `useAgentDisplay`/`useAgentCommands`, `task-navigation.ts` →
  `agent-navigation.ts`.
- `TaskStatus` (active/completed/error/abandoned) → `AgentLifecycleStatus`,
  because `AgentStatus` already names the live detector status.
- `TaskState` (Zustand store shape) → `AgentStoreState`, because `AgentState`
  already names the live detector state.
- `routes/tasks.ts` merged into `routes/agents.ts`: `GET /agents` lists,
  `POST /agents` launches, `/sessions/*` unchanged. The remote-control listener
  filters its table by request method before dispatch so the non-surfaced
  `POST /agents` still answers 404 rather than 405.
- `mcp/tools-tasks.ts` → `mcp/tools-sessions.ts` (`sessionsModule`), since
  `tools-agents.ts` already exists; the tool itself is `list_tasks` →
  `list_agents`.
- Status hooks that already had a live `agent` local now call the persisted
  record `agent` and the live state `live`.
- Wire/persisted names: IPC `tasks:*` → `agents:*`, `task-updated` →
  `agent-updated`, preload `electronAPI.tasks` → `electronAPI.agents`, pane
  content type `"task"` → `"agent"`, notification target `{ type: "task", taskId }`
  → `{ type: "agent", agentId }`, preferences `taskRetentionDays` /
  `taskPruneNoticeShown` → `agentRetentionDays` / `agentPruneNoticeShown`,
  and `~/.manor/tasks.json` → `~/.manor/agents.json` with top-level key
  `agents`.
- On-disk data is migrated on load, once: `tasks.json` is renamed to
  `agents.json` (a legacy `tasks` key is read and rewritten), the two
  preference keys are adopted and dropped, and legacy notification targets are
  rewritten in memory.
- Historical ADRs and `CHANGELOG.md` keep the old wording; `docs/AGENT-TASK-SYSTEM.md`
  becomes `docs/AGENT-SYSTEM.md` with an updated vocabulary table.

## Consequences

- One vocabulary in code, UI, IPC, HTTP and MCP. "Agent" now means the
  persisted record; the live process state is "agent process" / `AgentState`.
- External callers of the loopback API or MCP server must use `GET /agents`
  and `list_agents`; `split_pane`'s content type is `"agent"`.
- The remote-client service worker message `open-task` became `open-agent`;
  a stale cached service worker will miss one notification click until it
  updates.
- `AgentInfo` next to `AgentState` is a mild readability cost, documented in
  `docs/AGENT-SYSTEM.md`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
