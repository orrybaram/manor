---
title: TerminalHostClient reconnects after daemon loss and reconciles subscriptions
status: done
priority: critical
assignee: opus
blocked_by: []
---

# TerminalHostClient reconnects after daemon loss and reconciles subscriptions

In `electron/terminal-host/client.ts`:

1. Add `private wanted = new Set<string>()` — sessions the app wants to be subscribed to. Add in `doCreateOrAttach` (both subscribe sites); delete in `kill()` and `detach()`. Do **not** clear it in `cleanup()`.
2. Add `private intentionalDisconnect = false`. `disconnect()` sets it true before `cleanup()` and resets it after. `handleDisconnect()` (called from socket `close`/`error` while connected) calls `cleanup()` and, unless the disconnect was intentional, calls `void this.reconnectAfterLoss()`.
3. `reconnectAfterLoss()`: guard against re-entry with a `reconnecting` flag; try `this.connect()` up to 3 times with delays 250 ms, 1 s, 2 s; on final failure emit `{ type: "exit", sessionId, exitCode: -1 }` for every wanted session and clear the set. Log each attempt with `console.warn("[terminal-host] …")`.
4. `reconcileSubscriptions()` — called at the very end of `doConnect()` after the stream socket is up: if `wanted` is empty return; `listSessions()`; for each wanted id, if present send `subscribe` on the stream socket, else remove from `wanted` and emit the synthetic `exit` event through `eventHandler`. Emit events asynchronously (`queueMicrotask` is fine) so a handler that throws cannot break `connect()`.
5. Make sure `killAndRespawn()` inside `doConnect()` still ends with reconciliation (it does if step 4 runs at the end of `doConnect()` — the fresh daemon will report no sessions, so every wanted session gets an `exit`).
6. `writeNoAck` stays fire-and-forget; while disconnected, writes are dropped (documented in a comment) — the reconnect will close the pane anyway.

Keep the `exit` event shape compatible with `StreamEvent` in `terminal-host/types.ts` (`exitCode: number`). `handleStreamEvent` in `app-lifecycle.ts` already forwards `exit` as `pty-exit-<id>`; no change needed there.

Run `npx tsc --noEmit -p tsconfig.electron.json` (or the project's typecheck script) and the existing `electron/terminal-host/client.test.ts`.

## Files to touch
- `electron/terminal-host/client.ts` — wanted set, intentional flag, reconnect loop, reconcile
