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

# ADR-205: Unblock the Electron main-process startup path

## Context

Issue #301, from the 2026-09-30 performance audit. Four things sit between
process start and the first window, or between the window and a usable app:

1. **Synchronous login shell.** `electron/main.ts` runs
   `execFileSync($SHELL, ["-lc", "echo $PATH"], { timeout: 3000 })` at module
   top level in packaged builds, before `app.whenReady()`. A heavy shell
   profile (nvm, conda, oh-my-zsh) blocks startup for up to 3 s on every
   launch. Only child-process spawns need that PATH.
2. **One eagerly evaluated ~914 KB bundle.** `dist-electron/main.js` is
   913.65 kB. `electron-updater` (via `electron/updater.ts`), `web-push` (via
   `electron/remote-control/push.ts`) and the remote-control listener and
   tunnel (`remote-control/server.ts`, `tunnel.ts`) are imported statically
   from `app-lifecycle.ts`, `ipc/misc.ts` and `routes/system.ts`, so they are
   parsed and evaluated on every launch. The updater first does anything 5 s
   after ready; remote control is off at every launch (ADR-161) and only a
   deliberate user action starts it.
3. **Synchronous file work before ready.** `bootstrapHost()` (shell
   integration, hook scripts, agent connector configs) and `ensureManorCli()`
   run inside `initApp()`, before `whenReady`.
4. **Serial server startup.** After the window opens, `agentHookServer.start()`,
   `webviewServer.start()` and `portlessManager.start()` are awaited one after
   another, then `backend.connect()`. The three servers are independent — each
   binds its own port — and only `connect()` needs all three ports in env.

## Decision

### 1. Cached login PATH, resolved asynchronously (`electron/login-path.ts`)

New module, Electron-free apart from being called from main:

- `readCachedLoginPath()` — sync read of a tiny JSON file
  (`manorDataDir()/login-path.json`, `{ path, shell, resolvedAt }`, getter in
  `electron/paths.ts`). A file read, not a shell spawn. Ignored if `shell`
  differs from the current `$SHELL`.
- `withCommonPaths(path)` — today's fallback (prepend `/opt/homebrew/bin`,
  `/usr/local/bin` when missing).
- `resolveLoginPath(shell)` — async `execFile(shell, ["-lc", "echo $PATH"],
  { timeout: 3000 })`; resolves to the trimmed PATH or null.
- `startLoginPathResolution()` — called once from `main.ts` when packaged:
  applies the cached PATH (or the common-paths fallback when there is none)
  to `process.env.PATH` synchronously, then starts the async resolve. On
  success it sets `process.env.PATH` and rewrites the cache (only if changed).
  Returns nothing; stores a promise.
- `loginPathReady(): Promise<void>` — resolves immediately when a cache was
  applied (the cached PATH *is* the user's login PATH from last run), and
  otherwise (first run, or shell changed) resolves when the async resolve
  settles. Never rejects.

`app-lifecycle.ts` awaits `loginPathReady()` before `backend.connect()`,
because the daemon is the process that spawns every PTY and inherits PATH at
spawn time (it is not in `LOCAL_ENV_KEYS`). On a normal launch that await is
free; on first run it costs what the sync shell used to cost, but after the
window is up rather than before it.

### 2. Lazy `electron-updater`

`electron/updater.ts` drops the static `electron-updater` import and loads it
with `await import("electron-updater")` behind a memoised `loadUpdater()`.
`initAutoUpdater(getWindow)` schedules the load, the listener wiring and the
first check for 5 s after it is called (the existing first-check delay), plus
the 4 h interval. `checkForUpdates()` and `quitAndInstall()` keep their `void`
signatures and load on demand, fire-and-forget (a manual "Check for updates"
before the timer fires still works and wires listeners exactly once); their
outcome reaches the renderer through the `updater:*` events, as before, so
callers are unchanged.

The memoise-and-retry loading used here, for `web-push` and for the
remote-control runtime lives in one helper, `electron/lib/lazy.ts` (`lazy()`,
plus `cjsExports()` for the CommonJS default-export shape).

### 3. Lazy remote-control runtime

- `push.ts`: `web-push` is imported dynamically inside `PushManager` the first
  time it needs to send or generate VAPID keys. `notify()` already returns
  early with no subscriptions, so a user with no paired phones never loads
  it. The injectable `send`/key-generator seams stay for tests. `isPushable`
  and `pushPayloadFor` stay static (pure).
- `RemoteControlController` no longer takes a constructed server and tunnel.
  It takes a `loadRuntime: () => Promise<{ server, tunnel }>` factory
  (memoised inside the controller) that `app-lifecycle.ts` implements with
  `import("./remote-control/server")` and `import("./remote-control/tunnel")`.
  `RemoteDeviceStore` stays eager (the settings panel lists devices with
  remote control off; it has no heavy deps).
  - `status()` stays synchronous: with no runtime loaded it reports
    `enabled: false, port: null, listeners: 0` and a default stopped
    `TunnelStatus` (exported as a constant from a light module, e.g.
    `remote-control/tunnel-status.ts`, alongside the `TunnelKind`/
    `TunnelStatus` types, which `tunnel.ts` re-exports).
  - `onAgentStatus` skips `publishStatus` when the runtime isn't loaded (no
    listener → nothing to publish); push behaviour unchanged.
  - `setEnabled(true)`, `startTunnel` load the runtime. `refreshDetection`
    probes PATH with the injected `which` directly rather than loading the
    tunnel module, so opening the settings panel does not load it.
    `setEnabled(false)`, `stopTunnel`, `shutdown` and `killTunnelNow` are
    no-ops for parts never loaded.
  - The controller subscribes to `tunnel.onStatus` when the runtime loads.

### 4. Startup ordering in `app-lifecycle.ts`

- `bootstrapHost()` and `ensureManorCli()` move from `initApp()` into the
  `whenReady` handler, after `openPrimaryWindow()` and before
  `backend.connect()` (PTYs need the hook scripts and shell integration they
  write; nothing before connect does).
- The hook server, webview server and portless proxy start with
  `Promise.all`, alongside `loginPathReady()`; env vars are set from their
  ports once all settle; then `backend.connect()`. `portlessManager.start()`
  failing must not stop the others — keep today's failure semantics (check
  whether it throws today; if it does, it did so serially too).
- `initAutoUpdater` is called where it is today; with §2 it costs nothing
  until its timer fires.
- A one-line `[startup]` log records ms from process start
  (`performance.now()`) to `openPrimaryWindow()` and to the window's
  `ready-to-show`, for the before/after numbers in the PR.

## Consequences

- No shell spawn and no heavy module evaluation before the first window;
  the updater, web-push and the remote-control server/tunnel become separate
  chunks in `dist-electron/` (already packaged via `dist-electron/**/*`).
  Relies on Vite lib-mode CJS output code-splitting dynamic imports — verify
  chunks appear in the build.
- A PATH change in the user's profile reaches Manor's spawns one launch late
  for the daemon (it spawns on the cached PATH when one exists); main's own
  later spawns (gh, git) pick it up as soon as the background resolve lands.
  The daemon usually outlives app restarts anyway, so this matches how PATH
  already behaved for long-lived daemons.
- First run (no cache) still pays for the login shell, but after the window.
- `PushManager.publicKey()` becomes async (generating keys may load
  `web-push`).
- A local server that fails to start (in practice only the portless proxy can)
  is logged and its port left unset; the daemon still connects. Before, the
  failure aborted the rest of startup.
- On first run only, main's own spawns (`gh`, `git`) use the common-paths
  fallback for the few seconds until the login shell answers.
- `RemoteControlController` gains a "not loaded" state its tests must cover.
- `electron-updater`/`web-push` vi.mocks in tests keep working (vi.mock
  covers dynamic imports).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
