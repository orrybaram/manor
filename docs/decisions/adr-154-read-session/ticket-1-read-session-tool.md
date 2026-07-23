---
title: read_session MCP tool + /sessions/read route (snapshot-first, scrollback fallback)
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# read_session MCP tool + /sessions/read route

The read-only twin of `send_to_session`: return another session's rendered output
(its conversation/transcript) by the handle `list_tasks` returns. Main-served,
reuses everything ADR-153 already put in place.

## Context (all already exists on this branch)
- `deps.backend` is a `LocalBackend` (threaded into `ControlDeps` by ADR-153). It
  exposes `deps.backend.pty.getSnapshot(sessionId): Promise<TerminalSnapshot | null>`
  (`electron/backend/local-pty.ts:46`). `TerminalSnapshot.screenAnsi` is the
  serialized headless-xterm buffer — the rendered conversation (redraws collapsed),
  and it already includes scrollback.
- `deps.taskManager` + `resolveTarget(taskManager, target)` (already defined in
  `electron/routes/tasks.ts:60`) map a handle → `TaskInfo`. `task.paneId` is the
  daemon sessionId / scrollback key.
- `stripAnsi(str)` is exported from `electron/terminal-host/output-pattern-matcher.ts:14`.
- `ScrollbackWriter.readScrollback(sessionId)` (`electron/terminal-host/scrollback.ts:192`)
  reads the on-disk `scrollback.bin` tail for ENDED sessions (when the live
  snapshot is gone).

## Build

### 1. `POST /sessions/read` — add to the `tasksRoutes` array in `electron/routes/tasks.ts`
Reuse the in-module `resolveTarget` (do NOT duplicate it). Mirror the structure/
guards of the existing `POST /sessions/send` handler.

- Body: `{ target: string, tailLines?: number, maxBytes?: number, raw?: boolean }`.
- Guards: 503 if `!deps.taskManager` or `!deps.backend`; 400 if `target` is not a
  non-empty string.
- `const task = resolveTarget(deps.taskManager, target)` → 404 if null; 409 if
  `!task.paneId`.
- **Live first:** `const snap = await deps.backend.pty.getSnapshot(task.paneId)`.
  If `snap`, `ansi = snap.screenAnsi`, `source = "live"`.
- **Fallback:** if `snap` is null, `ansi = ScrollbackWriter.readScrollback(task.paneId)`,
  `source = "scrollback"`. (Import `ScrollbackWriter` from
  `../terminal-host/scrollback`.) If both yield empty, still return `ok:true` with
  empty text and the source that was attempted.
- Format: `raw === true` → keep `ansi` verbatim as the payload; else
  `stripAnsi(ansi)`.
- Tail: default last **200** lines. If `tailLines` is a positive finite number,
  use it. Apply after stripping: split on `/\r?\n/`, take the last N, track whether
  truncation happened. If `maxBytes` is a positive finite number, additionally cap
  the returned string to that many bytes from the END (UTF-8-safe — reuse the
  continuation-byte skip pattern already in `scrollback.ts`, or just slice on a
  char boundary). Keep it simple; the source is already capped at ~500KB.
- Respond `json(200, { ok: true, target: { id: task.id, paneId: task.paneId,
  lastAgentStatus: task.lastAgentStatus }, source, text | raw, lineCount, truncated })`.
  (Use key `text` when stripped, `raw` when `raw:true` — or always `text`; pick one
  and reflect it in the tool formatter.)

### 2. `read_session` MCP tool — add to `tasksModule` in `electron/mcp/tools-tasks.ts`
- Def: required `target` (string); optional `tailLines` (number), `maxBytes`
  (number), `raw` (boolean). Description: "Read another session's rendered output
  (its conversation/transcript) by the handle `list_tasks` returns. Returns plain
  text by default; pass `raw:true` for the ANSI stream. Read-only — does not touch
  the session. Works for running sessions (live rendered buffer) and ended ones
  (persisted scrollback)."
- Handler: `await http.post("/sessions/read", { target, tailLines, maxBytes, raw })`,
  then format via the `text()` helper — a short header line
  (`source=<live|scrollback> lines=<n>${truncated ? " (truncated)" : ""}`) followed
  by the output body.

## Files to touch
- `electron/routes/tasks.ts` — add the `POST /sessions/read` route; add imports for
  `stripAnsi` and `ScrollbackWriter`.
- `electron/mcp/tools-tasks.ts` — add the `read_session` tool def + handler to `tasksModule`.

## Verify (pnpm; repo has PRE-EXISTING unrelated tsc/lint errors — compare to baseline)
- `pnpm exec tsc -p tsconfig.electron.json --noEmit`
- `pnpm run lint`
- `pnpm run build` (must pass)
Ensure your changes add no NEW errors.

## Notes
- Do NOT add a daemon RPC or streaming/follow mode — snapshot-first already gives
  live state; those are explicitly deferred in the ADR.
