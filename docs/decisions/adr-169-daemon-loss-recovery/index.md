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

# ADR-169: Survive losing the terminal-host daemon, and stop the test suite from killing it

## Context

On 2026-09-06 at 19:12 two agent panes in the running Manor 0.10.1 froze: no output, keystrokes ignored, agent dots stuck on "working", and nothing in the UI offered a way out. The renderer itself was fine (the webview HTTP server still answered `/panes`); only the terminals were dead.

Forensics from `~/.manor` and `~/Library/Application Support/manor`:

- The production daemon (token written 16:33:40 at app start) shut down gracefully at 19:12:12 — its `terminal-host.sock` and `.pid` were unlinked, the token survived, and both panes' `sessions/*/meta.json` gained `endedAt: 23:12:12.306Z`. That is the SIGTERM path in `terminal-host/index.ts`.
- Two seconds earlier, `~/.manor/hook-port` and `~/.manor/webview-server-port` were deleted and `~/.manor/hooks/notify.{sh,js}` rewritten. That is `AgentHookServer.stop()`, `WebviewServer.stop()` and `ensureHookScript()`.
- A stray `~/.manor/sessions/pane-a4858e99-…` appeared at 19:11:53.
- The scrollback of the first frozen pane shows the agent running `npx vitest run 2>&1 | tail -15` for about a minute when the session died.

Reproduced deterministically: start a daemon under a throwaway `$HOME`, run `npx vitest run` with that `$HOME`, and the daemon is SIGTERMed within seven seconds. Bisected to `electron/__tests__/processes-kill-stats.test.ts`: its `processes:killAll` test invokes the real handler in `electron/ipc/processes.ts`, which reads `~/.manor/daemon/terminal-host.pid` via `paths.ts` and calls `process.kill(pid, "SIGTERM")`. Nothing in the test isolates `$HOME`, so on a developer machine it kills whatever daemon is serving the running app. Several other tests (`agent-hooks.test.ts`, `webview-server.test.ts`, `mcp-webview-server.test.ts`, `client.test.ts`) also write and delete files under the real `~/.manor` — they happen not to be destructive today, but they overwrite the live app's `hook-port` for the duration of the test and drop scrollback directories into the user's home.

The second half of the bug is that Manor cannot recover from the daemon going away, whatever the cause. `TerminalHostClient.handleDisconnect()` just calls `cleanup()`: sockets are nulled, `connected` goes false, pending requests reject. Nobody tells the renderer. `writeNoAck` silently drops keystrokes while disconnected. No reconnect is attempted until some later control request (`resize`, `create`, `kill`) happens to call `ensureConnected()`, and even then the client has forgotten which sessions it was subscribed to, so panes never learn their PTYs are gone. The same freeze happens after "Kill daemon" / "Kill all" in the Processes view, or after any daemon crash (`uncaughtException` → `shutdown()`), which ADR-090 and ADR-116 assumed the client would handle by "cold restore from scrollback" — but that only runs at pane mount.

## Decision

### 1. Isolate `$HOME` for the whole unit-test suite

Add a vitest setup file that runs before any test module is imported and points `process.env.HOME` at a fresh temp directory per worker (`fs.mkdtempSync(path.join(os.tmpdir(), "manor-vitest-home-"))`), removed on process exit. `paths.ts` resolves through `os.homedir()`, which honours `$HOME` on POSIX, and `TerminalHostClient` caches `manorHomeDir()` at import time — after the setup file has run. This makes every path under `~/.manor` and `~/Library/Application Support/Manor` land in the temp dir for every test, existing and future, without touching individual tests. A guard test asserts `manorHomeDir()` is under the temp dir and not under the real home so the isolation cannot be removed silently.

`processes-kill-stats.test.ts` additionally gets an explicit assertion that `killAll` does not signal any process when there is no pid file, plus a test that writes a pid file into the isolated `~/.manor/daemon` and asserts `process.kill` (stubbed) is called with that pid — the behaviour the handler is meant to have, now verifiable without side effects.

### 2. `TerminalHostClient` reconnects and reconciles subscriptions

- Track desired subscriptions in a `Set<string>` (added on `subscribe`, removed on `unsubscribe`/`kill`/`detach`). `cleanup()` does **not** clear it; it is the list of sessions the app still believes it has.
- On an *unexpected* disconnect (socket `close`/`error` while connected, as opposed to the explicit `disconnect()`), schedule a reconnect: retry `connect()` with a short backoff (three attempts, 250 ms → 1 s → 2 s). `connect()` already spawns a daemon when none is running.
- At the end of every successful `doConnect()`, reconcile: `listSessions()`, re-send `subscribe` for every wanted session that is still alive, and emit a synthetic `{ type: "exit", sessionId, exitCode: -1 }` stream event for each one that is not. This covers both the unexpected-disconnect path and the timeout path (`doRequest` timeout → `cleanup()` → next request reconnects), and the version-mismatch respawn inside `doConnect()` itself.
- If all reconnect attempts fail, emit `exit` for every wanted session and clear the set, so the UI never sits on a dead subscription.

The renderer already handles `pty-exit` by closing the pane (`useTerminalStream` → `closePaneById`), which also abandons the pane's agent record so it appears in the sidebar as resumable. No renderer change is needed for the freeze to become a visible, recoverable state.

### 3. Regression tests at the daemon-client seam

`client.test.ts` already hosts an in-process `TestDaemon`. Add tests that: (a) subscribe to a session, restart the daemon on the same socket with an empty session table, and assert the client emits `exit` for the lost session and is usable again (`ping()` → true); (b) drop only the sockets while the daemon and session survive, and assert the client re-subscribes and keeps receiving output; (c) assert `kill`/`detach` remove the session from the wanted set so no spurious `exit` is emitted for a session the app closed itself.

## Consequences

**Better**

- `pnpm test` on a developer machine can no longer terminate the daemon behind the developer's own Manor window, overwrite its `hook-port`, or litter `~/.manor/sessions`. Agents working on this repository (the exact trigger here) can run the suite safely.
- Daemon loss of any kind — crash, "Kill daemon" in the Processes view, a stale-version respawn, a test gone wrong — now surfaces within about a second as closed panes with resumable agents, instead of an indistinguishable freeze. New terminals work immediately because the client has already respawned the daemon.
- Timeouts (ADR-090) no longer silently orphan subscriptions.

**Worse / risks**

- Closing the pane is the recovery. The user loses the visible scrollback of a dead session (it is still on disk under `~/.manor/sessions`) and has to resume the agent from the sidebar. A toast explaining "terminal host restarted, N sessions lost" would be a good follow-up but is out of scope here.
- A reconnect that succeeds against a daemon that is alive but wedged will re-subscribe to sessions that never produce output. That is the pre-existing ADR-090 territory; the 10 s request timeout still applies.
- Tests that deliberately relied on the real home (none found) would break. The guard test makes any such future test fail loudly rather than reach the real `~/.manor`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
