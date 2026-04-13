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

# ADR-117: Orphaned Session Discovery in Processes View

## Context

Manor's terminal-host daemon is intentionally kept alive across app restarts. This means any process running inside a PTY session — including `npm run dev`, build watchers, or test runners — outlives the pane that spawned it.

This becomes a problem when:
1. A user closes a pane while a long-running process is inside it. The shell exits (SIGHUP), but Node/npm typically ignores SIGHUP and keeps running.
2. Manor crashes or quits while sessions are alive. The daemon survives (by design), but the restored layout may not include all prior panes.

In both cases the process is still running and consuming resources, but the user has no way to find or kill it from within Manor. The Processes view (ADR-114) already shows port-scanned processes, but it does not surface these "orphaned" daemon sessions explicitly ([orrybaram/manor#115](https://github.com/orrybaram/manor/issues/115)).

## Decision

**Definition**: an orphaned session is one that is alive in the daemon but has no corresponding pane in the currently persisted layout across any workspace.

### 1. `LayoutPersistence.getActiveSessionIds()`

Add a method to `LayoutPersistence` that reads the layout file and returns the `Set<string>` of all `daemonSessionId` values referenced by any pane, across all workspaces and panels. This is a pure read operation — no side effects.

### 2. `processes:list` marks orphaned sessions

In the `processes:list` IPC handler, cross-reference the daemon's session list against `getActiveSessionIds()`. Any session that is alive but not in the active set gets `orphaned: true` in the response. Sessions that have a matching layout pane get `orphaned: false`.

This also fixes a companion bug: the `getDaemonDir()` helper in `processes.ts` was still using the old versioned path (`~/.manor/daemons/{version}/`). Updated to use the fixed path (`~/.manor/daemon/`) introduced in ADR-116.

### 3. "Orphaned Sessions" section in `ProcessesView`

When orphaned sessions exist, a distinct "Orphaned Sessions" section appears below the regular Sessions section in the Processes command-palette view. Each entry shows the session's short ID and last known CWD. A Kill button terminates the session via the existing `processes:killSession` IPC.

Regular Sessions are filtered to show only non-orphaned entries, so each session appears exactly once.

## Consequences

**Better:**
- Users can see and kill processes that survived pane close or app crash, without leaving Manor.
- The Processes view is now a complete inventory of what the daemon is running, whether or not there's a visible pane for it.

**Neutral:**
- Orphaned session detection reads the layout file once per `processes:list` call (synchronous disk read of a small JSON file). No performance impact.
- Sessions created by the prewarm manager are excluded from `listSessions()` by design (they're filtered in `terminal-host.ts`), so they won't appear as orphaned.

**Out of scope:**
- "Reopen" / reattach: opening a new pane and wiring it to an existing daemon session requires layout store changes and a new IPC channel. Left as a follow-up.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
