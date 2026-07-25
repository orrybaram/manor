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

# ADR-154: `read_session` — read another session's output over MCP

## Context

ADR-153 gave the orchestrator (and any MCP client) the ability to *see session
metadata* (`list_tasks`) and *steer* a session (`send_to_session`, interrupt +
inject). The obvious missing capability surfaced immediately in use: **there is
no way to read the actual output/conversation of another session.** `list_tasks`
returns status and a handle; nothing returns what an agent has said or done.
Manor exposes no read-only tool for terminal-pane scrollback, and the control
server isn't a browser pane, so there's no screenshot/console-log path either.

This ADR adds the read-only twin of `send_to_session`: **`read_session`**.

### What the codebase already provides (research findings)

- **A live, rendered terminal buffer per session.** The terminal-host daemon
  keeps a headless xterm emulator with a `SerializeAddon` for every session
  (`electron/terminal-host/session.ts:16,73-74,439-444`). `session.getSnapshot()`
  returns a `TerminalSnapshot { screenAnsi, scrollbackAnsi, modes, cwd, cols,
  rows }` where `screenAnsi` is the serialized buffer (redraws already collapsed;
  the comment notes "headless serialize already includes scrollback").
- **A working RPC, already reachable from main.** `TerminalHost.getSnapshot(
  sessionId)` (`electron/terminal-host/terminal-host.ts:92`) →
  `TerminalHostClient.getSnapshot` (`client.ts:325`) → exposed on the backend as
  `LocalBackend.pty.getSnapshot(sessionId)` (`electron/backend/local-pty.ts:46`).
  ADR-153 already threaded `backend: LocalBackend | null` into `ControlDeps`, so
  `deps.backend.pty.getSnapshot(paneId)` is callable from a route today.
- **Persisted scrollback for ended sessions.** When a session's emulator is gone
  (ended), the live snapshot returns `null`, but raw output persists on disk at
  `~/.manor/sessions/{sessionId}/scrollback.bin` with a ready static reader
  `ScrollbackWriter.readScrollback(sessionId)` (`electron/terminal-host/
  scrollback.ts:192`, tails 500KB at a UTF-8-safe boundary).
- **Identity is unified.** The pane's `MANOR_PANE_ID` env == the daemon
  `sessionId` == the scrollback dir key == `TaskInfo.paneId`
  (`session.ts:231`). So a task handle maps directly to both the snapshot RPC and
  the on-disk scrollback.
- **An ANSI stripper exists.** `stripAnsi()` is exported from
  `electron/terminal-host/output-pattern-matcher.ts:14`.
- **A target resolver exists.** `resolveTarget(taskManager, target)` in
  `electron/routes/tasks.ts:60` already maps a handle (`id` / `paneId` /
  `#<issue>` / branch / name) to a `TaskInfo` for `send_to_session`. `read_session`
  reuses it.

### Why rendered snapshot over raw scrollback (design rationale)

`claude`/`codex` are full-screen TUIs that redraw constantly. Raw `scrollback.bin`
is a stream of overlapping redraw frames and cursor moves; regex-stripping it
yields garbled, duplicated text. The headless emulator has already *replayed*
those escape sequences into the final on-screen content, so `screenAnsi` is the
conversation as actually rendered — and it's live (no ~2s disk-flush lag). Hence:
**snapshot first, disk-scrollback only as the fallback for ended sessions.**

## Decision

Add one read-only MCP tool `read_session` backed by one new route, reusing the
already-threaded backend, the existing resolver, and the existing ANSI stripper.
No new dependencies, no renderer round-trip, no daemon changes.

### Route — `POST /sessions/read` (in `electron/routes/tasks.ts`)

Body `{ target: string, tailLines?: number, maxBytes?: number, raw?: boolean }`.

1. 503 if `deps.taskManager` / `deps.backend` is null; 400 if `target` missing.
2. `task = resolveTarget(deps.taskManager, target)`; 404 if unresolved; 409 if no
   `paneId`.
3. **Live first:** `snap = await deps.backend.pty.getSnapshot(task.paneId)`. If
   `snap`, use `snap.screenAnsi` and mark `source: "live"`.
4. **Fallback:** if `snap` is null, `ScrollbackWriter.readScrollback(task.paneId)`
   from disk, mark `source: "scrollback"` (raw, rawer — note it in the response).
5. `raw` → return the ANSI verbatim; otherwise `stripAnsi(...)` to plain text.
6. Tail: default last **200** lines; `tailLines` widens; `maxBytes` caps bytes
   (both bounded by the 500KB source cap).
7. Respond `{ ok, target: { id, paneId, lastAgentStatus }, source, text|raw,
   lineCount, truncated }`.

### MCP tool — `read_session` (in `electron/mcp/tools-tasks.ts`, `tasksModule`)

Def: required `target`; optional `tailLines`, `maxBytes`, `raw`. Description:
*"Read another session's rendered output (its conversation/transcript) by the
handle `list_tasks` returns. Plain text by default; `raw:true` for ANSI. Read-only
— does not touch the session."* Handler posts to `/sessions/read` and formats the
returned text (with a short `source`/`truncated` header) via `text()`.

## Consequences

**Better**
- Completes the orchestration loop: **see (`list_tasks`) → read (`read_session`)
  → steer (`send_to_session`) / spawn**. The orchestrator can now inspect what an
  agent actually did before acting.
- Works for both **running** (live rendered snapshot) and **ended** (disk
  scrollback) sessions.
- Tiny surface: one route + one tool, reusing threaded backend, resolver, and
  stripper. No new deps, no daemon/renderer changes.

**Harder / risks**
- Snapshot vs scrollback yield slightly different fidelity (`source` field makes
  it explicit). Ended-session fallback text is rawer (pre-render frames).
- `stripAnsi` is regex-based; exotic sequences may leave crumbs. Acceptable for
  agent consumption; `raw` is the escape hatch.
- The fuzzy branches of `resolveTarget` (`#issue`/branch) only scan *active*
  tasks, so reading an ended session works reliably by `id`/`paneId` (what
  `list_tasks` hands back) but not always by branch. Noted; not worth widening now.
- Reading large buffers into an agent's context is a token cost — the 200-line
  tail default mitigates it.

**Deferred**
- A live-tail/streaming read (follow mode) and a daemon flush-before-read RPC —
  not needed while snapshot-first already gives live state.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
