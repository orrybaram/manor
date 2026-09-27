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

# ADR-185: Sessions survive an app update

## Context

Updating Manor loses every running terminal and agent. Quitting and restarting
the app does not.

The terminal-host daemon is detached and outlives the app, which is why a plain
restart keeps everything alive. On connect, the client handshakes with the
daemon and `isDaemonStale` (`electron/terminal-host/types.ts`) replaces it when
**either** the app version differs **or** the daemon's `TERMINAL_HOST_PROTOCOL`
is older. Every release bumps the app version, so every update runs
`transport.restart()` (`electron/terminal-host/client.ts`), which SIGTERMs the
daemon. `shutdown` → `disposeAll()` kills every PTY.

Agents are then not resumed. As each Claude pane dies, Claude fires its
`SessionEnd` hook. The new app's hook server is already listening (it starts
before `backend.connect()`), so the reconciler's H8 rule
(`electron/agent-status/reconciler.ts`) persists the Agent as `completed`. The
renderer's cold-restore path (`src/hooks/useTerminalLifecycle.ts`) only resumes
Agents with `status === "active"`, so nothing is resumed.

Evidence from a real update (v0.14.3, 2026-09-27):
- `~/.manor/daemon/terminal-host.log`: client connected `18:03:35.894`,
  `Shutting down...` `18:03:35.991`.
- `agents.json`: the retrograde Agent got `completedAt 18:03:36.708`,
  `resumedAt null`.
- `layout.json` and `~/.manor/sessions/*` scrollback were intact, so the layout
  survived and only the processes and agent resumes were lost.

The app-version check exists because the daemon binary is "mismatched" after an
update. In practice, what an old daemon needs from the new bundle is narrow:
- The daemon bundle (`terminal-host-index.js`) and its externals
  (`@xterm/headless`, `@xterm/addon-serialize`, `tree-kill`) are required at
  startup and stay in memory. The old code keeps running correctly after
  Squirrel swaps the `.app` bundle (or the remote bootstrap swaps
  `~/.manor/host/`).
- The only thing the daemon loads from disk afterwards is
  `path.join(__dirname, "pty-subprocess.js")`, forked per new session with
  `process.execPath`. After an update, both paths resolve to the **new**
  bundle. A new session therefore runs new `pty-subprocess.js` + new `node-pty`
  + new Electron. That combination is self-consistent, but it talks to the old
  daemon over the binary frame protocol in `pty-subprocess-ipc.ts`.

So the old daemon can keep serving a new app as long as two contracts match:
1. The daemon↔client wire protocol (`TERMINAL_HOST_PROTOCOL`, already
   versioned).
2. The daemon↔pty-subprocess frame protocol (currently unversioned).

## Decision

Two complementary changes.

### B — Replace the daemon only on protocol change, not app version

1. Add `PTY_SUBPROCESS_PROTOCOL` (start at `1`) to
   `electron/terminal-host/pty-subprocess-ipc.ts`, with a doc comment in the
   same style as `TERMINAL_HOST_PROTOCOL`'s history. Any change to frame types
   or payload shapes must bump it.
2. The daemon reports it in the handshake reply as `ptyProtocol` (alongside
   `protocol` and `daemonVersion`) in `electron/terminal-host/index.ts` and the
   `ControlResponse` handshake type in `types.ts`.
3. `isDaemonStale(response, clientVersion)` becomes a protocol check:
   stale iff `protocol !== TERMINAL_HOST_PROTOCOL` **or**
   `ptyProtocol !== PTY_SUBPROCESS_PROTOCOL`. A missing `ptyProtocol` (a daemon
   built before this ADR) counts as stale, so the release that ships this
   restarts the daemon one last time. Use `!==`, not `<`, so a downgrade also
   replaces a newer daemon. `daemonVersion` stays in the reply for
   diagnostics/logging only.
   - Dev builds are covered by the same rule. The old "same version, older
     protocol" case is subsumed.
4. Remote hosts go through the same `isDaemonStale` → `transport.restart()`
   path, so they inherit the rule. The bootstrap still reinstalls
   `~/.manor/host/` on a version change. The running remote daemon keeps its
   in-memory code and forks the new `pty-subprocess.js`, which is the same
   situation as local.
5. Add a guard test so a contract change cannot ship without a bump. A vitest
   fixture records a hash of the protocol-bearing sources together with the
   constants:
   - Sources: the `ControlRequest`/`ControlResponse`/stream event type
     declarations in `types.ts`, and `pty-subprocess-ipc.ts`.
   - Constants: `TERMINAL_HOST_PROTOCOL` and `PTY_SUBPROCESS_PROTOCOL`.

   If a hash changes while its constant has not, the test fails with a message
   telling the developer to bump the protocol (or re-record the fixture if the
   change is cosmetic). The version check used to be the safety net. Now this
   test is.

### A — A daemon replacement is not an Agent finishing

For the restarts that still happen (protocol bumps, `kill_daemon`, a daemon
crash respawn):

1. Before `client.ts` calls `transport.restart()`, it lists the daemon's live
   sessions (`listSessions`). It then reports them through a new optional
   callback (`onDaemonReplacing(sessionIds)`), which the host connection
   (`electron/backend/host-connection.ts`) forwards as a registry event, like
   `resumed`.
2. `app-lifecycle.ts` wires that event to a new driver method,
   `agentStatusDriver.expectPaneLoss(paneIds, ttlMs = 60_000)`.
3. In the reconciler, a `SessionEnd` for a pane inside its expected-loss window
   still resets the pane (idle, root dropped). It must **not** emit
   `PersistAgentStatus → completed` (a held-Stop drain to `responded` is fine).
   The Agent stays `active` with its `paneId`, so the renderer's existing cold
   restore resumes it via `buildResumeCommand`. Any other signal that would
   complete or abandon an Agent because its pty exited gets the same
   suppression inside the window.
4. The window is per pane. It ends on TTL, or when the pane's new session
   starts (a `SessionStart` hook for that pane), whichever comes first.

## Consequences

**Better**
- Most updates keep every shell, dev server and agent alive, because protocol
  bumps are rare compared with releases.
- When a restart is unavoidable, agents come back resumed instead of silently
  marked done.
- Restart decisions follow the contract that actually matters, not a version
  string.

**Harder / risks**
- An old daemon keeps running old daemon code after an update. Daemon-side bug
  fixes (session, scrollback, pane-facts, hook journal) do not take effect
  until the next protocol bump or daemon restart. Mitigation: a fix that must
  reach users can bump `TERMINAL_HOST_PROTOCOL` on purpose, which is the
  documented use of that number ("carrying the thing it exists to carry").
- Correctness now depends on bumping protocols. The hash guard test catches
  shape changes, but not semantic changes with the same shape (the ADR-165
  kind). Those still rely on review and the protocol doc comment.
- A long-lived daemon mixes pty-subprocess generations: old sessions run old
  subprocesses, new sessions run new ones. Both speak the same frame protocol
  by construction.
- If `node-pty` or Electron changes ABI across an update, only new
  subprocesses are affected, and they use the new, consistent binary set.
- The expected-loss window could swallow a genuine user `/exit` that races a
  daemon restart. That is acceptable: the worst case is a resume of a session
  the user just closed.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
