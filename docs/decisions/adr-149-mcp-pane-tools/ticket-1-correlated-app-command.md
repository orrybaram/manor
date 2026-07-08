---
title: Correlated main↔renderer app-command channel
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Correlated main↔renderer app-command channel

Today `webContents.send("app-command", …)` is one-way (`electron/control-server.ts:55-66`).
Pane tools need a return value (the new `paneId`). Add optional request/response
correlation **without** changing the semantics of existing commands.

## Design

Extend `AppCommand` with an optional `requestId`. Presence of `requestId` is the
signal that the renderer must reply.

```ts
/** Payload of the main→renderer "app-command" channel. */
export interface AppCommand {
  cmd: string;
  /** Present iff main expects a reply on "app-command-result". */
  requestId?: string;
  workspacePath?: string;
  prompt?: string;
  script?: string;
  /** Free-form args for correlated pane/tab commands. */
  args?: Record<string, unknown>;
}

/** Payload of the renderer→main "app-command-result" channel. */
export interface AppCommandResult {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
```

Add to `electron/control-server.ts`:

```ts
export function requestRenderer<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ ok: boolean; data?: T; error?: string }>
```

Behavior:
- No window → resolve `{ ok: false, error: "No Manor window is open" }` (same
  string `startAgent` uses; callers map this to HTTP 503).
- Generate `requestId` with `crypto.randomUUID()`.
- Register **one** `ipcMain.on("app-command-result", …)` listener lazily on first
  use (module-level `let installed = false`), routing by `requestId` through a
  module-level `Map<string, { resolve, timer }>`.
  Do **not** use `ipcMain.once` — it leaks a listener per timed-out request.
- On timeout: delete the map entry, resolve `{ ok: false, error: "Renderer did not respond" }`.
  Resolve, don't reject — callers turn `ok:false` into an HTTP error, and an
  unhandled rejection in a route handler would 500.
- On reply: `clearTimeout`, delete the entry, resolve the payload.
- Ignore replies with an unknown `requestId` (late arrival after timeout).

Leave `startAgent` / `runSetupScript` / `notifyProjectsChanged` exactly as they
are — they send no `requestId`, so no renderer reply is expected.

## Preload

`electron/preload.ts:421` — `onAppCommand` currently forwards only the payload.
Add a sibling for the reply direction rather than changing the callback shape
(App.tsx will call it explicitly):

```ts
sendAppCommandResult: (result: AppCommandResult) =>
  ipcRenderer.send("app-command-result", result),
```

Keep `onAppCommand`'s existing signature; just widen the payload type to the
shared `AppCommand` (it already imports it).

## Files to touch

- `electron/control-server.ts` — extend `AppCommand`, add `AppCommandResult`,
  add `requestRenderer()` + the correlation map and lazy `ipcMain.on` install.
  Import `ipcMain` alongside `BrowserWindow`.
- `electron/preload.ts` — add `sendAppCommandResult`; widen `onAppCommand` payload type.
- `src/electron.d.ts:585` — mirror the widened `onAppCommand` payload and add
  `sendAppCommandResult` to the API surface. Keep it structurally identical to
  `AppCommand` (ADR-145 nit #4 shared this type; don't re-diverge it).

## Tests

`electron/__tests__/mcp-webview-server.test.ts` already mocks `electron` at `:30-37`
with `BrowserWindow.getAllWindows` and spies on `webContents.send`. Extend that
mock with an `ipcMain` stub that captures the `app-command-result` listener, then
add a `describe("requestRenderer")` covering:

- Resolves `{ ok: true, data }` when the captured listener is invoked with the
  matching `requestId` (read the `requestId` off the `send` spy's call args).
- Resolves `{ ok: false, error: "No Manor window is open" }` with no window.
- Resolves `{ ok: false }` on timeout — use `vi.useFakeTimers()` + `vi.advanceTimersByTime`.
- A reply with an unknown `requestId` does not throw and does not resolve a
  pending request.
- Two concurrent requests resolve independently and in the right order.
- Timed-out requests leave no entry behind (assert the second of two requests
  still resolves after the first times out).
