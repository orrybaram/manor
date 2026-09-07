---
title: Extract the shared HTTP client from the MCP entry
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Extract the shared HTTP client from the MCP entry

Move port discovery and the `Http` implementation out of `electron/mcp-webview-server.ts`
into a module both the MCP entry and the upcoming CLI entry can import.

## Behaviour to preserve exactly

- `candidatePorts()`: `MANOR_WEBVIEW_PORT` env first, then `~/.manor/webview-server-port`
  (via `webviewServerPortFile()` from `./paths`), resolved per request, error
  `No Manor webview port found (env MANOR_WEBVIEW_PORT or <file>) — is Manor running?`
  when neither is set.
- `request()`: iterate candidates; connection-level `TypeError` with `cause` falls
  through to the next port; non-2xx throws `HttpError(status, parsedBody|null, rawBody)`;
  any other error is rethrown immediately.
- `httpPost` sets `Content-Type: application/json` only when a body is given, and
  applies `AbortSignal.timeout(timeoutMs)` when a timeout is passed.
- `httpDelete` mirrors `httpPost` without the timeout.

## Implementation

1. Create `electron/mcp/http-client.ts` exporting `createHttp(): Http` that returns
   `{ get, post, del }` built from the moved functions. Also export a helper
   `isConnectionError(err: unknown): boolean` (the `TypeError` + `cause` check) so the
   CLI can print "Cannot connect to Manor — is it running?" the same way `handleTool` does.
2. In `electron/mcp-webview-server.ts` delete the moved code and replace with
   `const http = createHttp();`. Use `isConnectionError` in `handleTool`.
3. Keep the module composition (`modules`, `TOOLS`, `handlers`) in the MCP entry for now;
   ticket 2 will move the `modules` array into `electron/mcp/modules.ts` so both entries
   share it. Do that move here instead if it keeps the diff cleaner, but do not change
   the order of the array.
4. Run `pnpm test:unit -- electron/__tests__/mcp-webview-server.test.ts` and
   `pnpm typecheck` (or the repo's equivalent script) to confirm nothing changed.

## Files to touch
- `electron/mcp/http-client.ts` — new; `createHttp`, `isConnectionError`
- `electron/mcp/modules.ts` — new (optional here, required by ticket 2); `export const modules = [webviewModule, projectsModule, agentsModule, panesModule, sessionsModule]`
- `electron/mcp-webview-server.ts` — remove moved code, import `createHttp`
