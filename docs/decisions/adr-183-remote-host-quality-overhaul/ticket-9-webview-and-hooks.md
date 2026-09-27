---
title: Split webview-server routes; unify hook ingest; atomic config writes
status: done
priority: medium
assignee: sonnet
blocked_by: [8]
---

# Split webview-server routes; unify hook ingest; atomic config writes

Read `index.md`.

1. **`webview-server.ts`** has about 1015 lines, mostly around 20
   `if (method === … && action === …)` branches in one handler.
   - Move them to `electron/routes/webview.ts`, following the existing
     `electron/routes/router.ts` pattern (see the other route modules).
   - `webview-server.ts` keeps the server lifecycle, console capture and
     `getWebContents`, about 250 lines.
2. **Pane host lookup through `ControlDeps`.**
   - Add `resolvePaneUrl(paneId, url)` to `ControlDeps`, backed by one
     main-owned pane→host map.
   - This replaces three things: `WebviewServer.paneHosts`, the `setPaneHost`
     setter, and `setRemoteUrlResolver`, which is installed as a side effect of
     `ports.register`, so `navigate` could run before it exists.
   - Use ticket 8's `RemoteUrlResolver`.
3. **Unify hook ingest.**
   - The local `AgentHookServer` uses `classifyHookRequest`, the same parser as
     the remote `hook-listener`.
   - `ingestHookPayload` takes a single `HookPayload` type, not
     `URLSearchParams | HookPayload`.
   - Delete the re-exports of `ensureHookScript` and `registerAllAgents` from
     `agent-hooks.ts`; tests import them from `terminal-host/bootstrap-host`.
4. **Atomic config writes.**
   - Add a shared `writeFileAtomic(path, data)` (tmp file + rename), based on
     the existing `writePortFileAtomic` in `agent-hooks.ts`, and have that
     function use it too.
   - Use it for every write in `agent-connectors.ts`.
   - Make `ConfigReadResult` a union, `{ ok: true; data } | { ok: false; warning }`.
   - Log each warning once, at the caller, not also in `warnSkip`.
5. **Finish "one `errorMessage` for main".** Ticket 1 added `electron/lib/errors.ts`. Replace the remaining inline `err instanceof Error ? err.message : String(err)` copies and local helpers, including `manor-cli.ts`, `diff-watcher.ts`, `terminal-host/exec-runner.ts`, `bridge.ts` (`describeError`), `client.ts`, `index.ts`, `hook-listener.ts`, `webview-server.ts`, `ipc/pty.ts`, `persistence.ts`/`electron/projects/*` and `agent-connectors.ts`. Keep any message wording a caller depends on.
6. **`ipc/agents.ts`.** Drop the `!deps.backendRegistry` check on a required
   field and fix the tests to use typed fixtures instead.

Run `pnpm build` and the related tests.

## Files to touch
- `electron/webview-server.ts`, `electron/routes/webview.ts` (new), `electron/routes/index.ts`
- `electron/ipc/webview.ts`, `electron/ipc/ports.ts`
- `electron/agent-hooks.ts`, `electron/agent-hook-events.ts`, `electron/terminal-host/hook-listener.ts`, `electron/backend/hook-feed.ts`
- `electron/agent-connectors.ts`, `electron/app-lifecycle.ts`, `electron/ipc/agents.ts`
- `electron/lib/fs-atomic.ts` (new)
- related tests
