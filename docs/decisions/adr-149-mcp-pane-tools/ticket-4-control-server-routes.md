---
title: Control-server /panes and /tabs routes
status: done
priority: high
assignee: sonnet
blocked_by: [1, 3]
---

# Control-server `/panes` and `/tabs` routes

Expose the renderer pane commands over HTTP so the MCP server (a separate Node
process) can reach them.

## Routes

Add segment branches to `handleControlRequest` (`electron/control-server.ts:161`),
alongside the existing `agents` / `projects` branches. Follow the established
shape: `const segments = url.pathname.split("/").filter(Boolean)`, validate,
`json(status, body)`, `return true`.

| Method + path | Renderer cmd | Success |
|---|---|---|
| `GET /panes` | `list-panes` | `200 { workspacePath, tabs: [...] }` |
| `POST /panes/split` | `split-pane` | `200 { paneId }` |
| `POST /panes/:paneId/focus` | `focus-pane` | `200 { ok: true }` |
| `DELETE /panes/:paneId` | `close-pane` | `200 { ok: true }` |
| `POST /tabs` | `new-tab` | `200 { tabId, paneId }` |

`POST /panes/split` body: `{ paneId?, direction, position?, contentType?, url?, command? }`.
`direction` is required and must be `"horizontal" | "vertical"` → else `400`.

`POST /tabs` body: `{ contentType, url?, command?, workspacePath?, background? }`.
`contentType` required, `"terminal" | "browser"` → else `400`.
`contentType: "browser"` requires `url` → else `400`.

Any other method on a matched path → `405 { error: "Method not allowed" }`, same
as the `agents` branch.

## Calling the renderer

Every one of these is a `requestRenderer()` call (ticket 1):

```ts
const result = await requestRenderer<{ paneId: string }>("split-pane", body);
if (!result.ok) {
  json(result.error === "No Manor window is open" ? 503 : 400, { error: result.error });
  return true;
}
json(200, result.data);
return true;
```

Map failures: `"No Manor window is open"` → `503` (matches `POST /agents` at
`control-server.ts:184`). `"Renderer did not respond"` → `503`. Everything else
is a handler throw (bad `paneId`, unknown workspace, invalid enum) → `400`.

Do not call `notifyProjectsChanged()` — these mutate layout, not project state.

## Body parsing

Note `readBody()` returns `Record<string, unknown>`. Type-narrow before use, as
the existing branches do (`typeof workspacePath !== "string"` → 400). The
renderer re-validates (ticket 3), but a `400` here is a better error than a
`400` bounced back through the IPC round-trip.

Pass the whole validated body through as the `args` field of the `AppCommand`.
For the `:paneId` path routes, merge the path segment in:
`requestRenderer("focus-pane", { paneId })`.

## Files to touch

- `electron/control-server.ts` — the new `panes` / `tabs` segment branches. Import
  `requestRenderer` from the same module (it's defined there in ticket 1).
- `electron/webview-server.ts` — **verify only, likely no change.** `:234-249`
  already delegates to `handleControlRequest` before its own routes and honors
  the `boolean` return. Confirm `/panes` doesn't collide with the
  `^\/webview\/([^/]+)` regex at `:269` (it shouldn't — different first segment).

## Tests

`electron/__tests__/mcp-webview-server.test.ts`, new `describe("WebviewServer pane routes")`
following the `"WebviewServer agent orchestration routes"` pattern at `:510` —
boot a real `WebviewServer` on a random port, `fetch` it, assert on the
`webContents.send` spy and on the HTTP response.

To make the round-trip resolvable, the `electron` mock's `webContents.send` spy
must synchronously invoke the captured `app-command-result` listener with the
`requestId` it was handed. Write that as a small test helper (`respondWith(data)`)
so each case reads clearly.

Cover: happy path for all five routes (assert the `app-command` payload shape and
the HTTP body); `400` on missing/invalid `direction`; `400` on `contentType:
"browser"` with no `url`; `405` on `GET /tabs`; `503` when no window is open;
`503` on renderer timeout.
