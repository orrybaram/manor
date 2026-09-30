---
title: Reorder and parallelise post-window startup
status: done
priority: high
assignee: sonnet
blocked_by: [1, 3]
---

# Reorder and parallelise post-window startup

See ADR-202 §4.

In `electron/app-lifecycle.ts`:

- Move the `bootstrapHost()` warnings loop and `ensureManorCli()` out of
  `initApp()`'s synchronous body into the `whenReady` handler, after
  `openPrimaryWindow()` and before `backend.connect()`. Wrap in try/catch so
  a failure logs and never aborts startup (check what they throw today).
- Replace the serial `await agentHookServer.start(); await webviewServer.start();
  await portlessManager.start();` with a `Promise.all` of the three plus
  `loginPathReady()` (from `./login-path`). Set `MANOR_HOOK_PORT`,
  `MANOR_WEBVIEW_PORT`, `MANOR_PORTLESS_PORT` and delete
  `MANOR_HOOK_PORT_FILE` after they settle, then `backend.connect()`. Preserve
  today's failure semantics per server (read each `start()` to see whether it
  can reject; a rejection today propagates out of the handler — if any can
  reject, prefer `Promise.allSettled` + per-server `console.error` so one bad
  server doesn't stop the daemon connecting, and note it in the commit).
- Add a startup timing log: `import { performance } from "node:perf_hooks"`;
  on the first `openPrimaryWindow()` log
  `[startup] window created at ${Math.round(performance.now())}ms` and on that
  window's `ready-to-show` (once) `[startup] window ready-to-show at …ms`.
  Only for the first window of the process.

## Files to touch
- `electron/app-lifecycle.ts`
