---
title: Codebase-wide Task → Agent rename with data migrations
status: done
priority: high
assignee: opus
blocked_by: []
---

# Codebase-wide Task → Agent rename with data migrations

Done as a single atomic pass because intermediate states do not typecheck:
pre-rename the colliding identifiers (`TaskStatus`, `TaskState`,
`tools-tasks`), move files with `git mv`, then apply a boundary-aware
substitution (`Task`/`Tasks` → `Agent`/`Agents`, `task`/`tasks` →
`agent`/`agents`, leaving `microtask` and friends alone), then fix the three
status hooks whose live `agent` local was shadowed, add the three on-disk
migrations with tests, and reconcile the remote-control allowlist with the
merged `/agents` route.

## Files to touch
- `electron/agent-persistence.ts` — rename; adopt `tasks.json` / `tasks` key once
- `electron/preferences.ts` — adopt `taskRetentionDays` / `taskPruneNoticeShown` once
- `electron/notification-store.ts` — rewrite `{ type: "task", taskId }` targets on load
- `electron/routes/agents.ts` — merged `GET /agents` + `POST /agents` + `/sessions/*`
- `electron/remote-control/server.ts` — filter the remote table by method before dispatch
- `electron/mcp/tools-sessions.ts` — `list_agents`, `send_to_session`, `read_session`
- `src/hooks/use{Tab,Workspace,Project}AgentStatus.ts` — live state renamed `live`
- everything else under `src/`, `electron/`, `tests/`, `README.md`, `docs/AGENT-SYSTEM.md`
