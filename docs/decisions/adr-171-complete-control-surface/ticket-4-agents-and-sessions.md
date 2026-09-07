---
title: Agent management routes and tools for the orphan session routes
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Agent management routes and tools for the orphan session routes

## Routes (`electron/routes/agents.ts`)

Mirror the IPC handlers in `electron/ipc/agents.ts` — including any renderer broadcast they do after a mutation (read `agents:delete` and the rename path; if IPC emits an `agents:*` update to the window, the route must too, via `getRendererWindows` from `ControlDeps` or the same helper IPC uses).

| Method | Path                              | Body       | Calls                                                                                                                                 |
| ------ | --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/agents/:agentId/rename`         | `{ name }` | `agentManager.updateAgent(id, { name })` (match what the renderer's `renameAgent` sends over IPC)                                     |
| DELETE | `/agents/:agentId`                | —          | `agentManager.deleteAgent` + the unseen-set cleanup IPC does                                                                          |
| POST   | `/agents/:agentId/seen`           | —          | whatever `agents:markSeen` does                                                                                                       |
| GET    | `/agents/:agentId/resume-command` | —          | same as `agents:buildResumeCommand`: `getConnector(kind).getResumeCommand(...)`; `404` if no agent, `409` if it has no `agentCommand` |

`agentId` also accepts a paneId the way `/sessions/read` does (see `agents-read.test.ts`); reuse that resolver.

## Tools

`electron/mcp/tools-agents.ts`: `rename_agent`, `delete_agent`, `mark_agent_seen`, `get_resume_command`.
`electron/mcp/tools-sessions.ts`: `interrupt_session` → `POST /sessions/interrupt`, `end_session` → `POST /sessions/end`. Read the two route handlers for their body contract; the tool descriptions must say what each does to the running agent.

## Tests

- `electron/routes/agents-manage.test.ts`: rename/delete/resume-command with an `AgentManager` stub, including 404 and 409.

## Files to touch

- `electron/routes/agents.ts`
- `electron/routes/agents-manage.test.ts` — new
- `electron/mcp/tools-agents.ts`
- `electron/mcp/tools-sessions.ts`
