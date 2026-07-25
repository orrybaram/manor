---
title: send_to_session MCP tool (interrupt + inject)
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# send_to_session MCP tool (interrupt + inject)

Let the orchestrator *steer* a running agent: interrupt its current turn, then
inject a new prompt. Main-served via `backend.pty.write`. Depends on ticket 2
(shares `tasksModule` + the `ControlDeps` threading that already added `backend`)
and ticket 1 (the main-side interrupt map).

## Semantics (locked with user: interrupt + inject)
1. Resolve `target` → a `TaskInfo` (and thus `paneId`).
2. Look up the graceful interrupt sequence for `task.agentKind` via
   `interruptSequenceFor(...)` (ticket 1, `electron/harness-interrupt.ts`) — for
   `custom` harness, callers may pass an override, else use the map default.
3. `backend.pty.write(paneId, interruptSequence)` to end the current turn
   gracefully (NEVER kill the process).
4. Then `backend.pty.write(paneId, text + "\r")` to submit the new prompt.
5. Return the target's `lastAgentStatus` (pre-interrupt) in the response so the
   caller knows whether it interrupted a `working` agent.

## What to build

1. **`POST /sessions/send` route** — add to `electron/routes/tasks.ts` (the file
   ticket 2 created), or a sibling registered in `routes/index.ts`:
   - Body: `{ target: string, text: string, interrupt?: string }`.
   - Resolve `target`: accept a raw `paneId`, a task `id`, `#<issue>`, or branch.
     Use `deps.taskManager` (`getTaskById` / scan `getActiveTasks()` by linked
     issue / workspace branch). 404-style error if unresolved or the task has no
     `paneId`.
   - Perform the interrupt-then-inject writes via `deps.backend.pty.write`
     (`electron/pty.ts:100` path). Respond `{ ok, target: {id, paneId,
     lastAgentStatus} }`.

2. **`send_to_session` MCP tool** — add to `tasksModule`
   (`electron/mcp/tools-tasks.ts`):
   - Def: required `target` (string), required `text` (string), optional
     `interrupt` (string, for custom harnesses). Description must state the
     interrupt+inject behavior and that it may discard the target's in-flight work.
   - Handler: `await http.post("/sessions/send", { target, text, interrupt })`,
     format the returned status into a short confirmation via `text()`.

## Files to touch
- `electron/routes/tasks.ts` — add `POST /sessions/send` handler.
- `electron/routes/index.ts` — ensure the route is registered (if not already via ticket 2's module).
- `electron/mcp/tools-tasks.ts` — add `send_to_session` tool to `tasksModule`.
- `electron/harness-interrupt.ts` — consumed here (created in ticket 1).

## Notes
- This is the riskiest piece (interrupt timing). Keep the write ordering exactly
  interrupt → small submit; do not add artificial delays that the pty layer can't
  guarantee. If idle-gating proves necessary, expose the target status (already
  returned) and let the orchestrator decide — do not silently swallow.
