---
title: Answer relayed control requests in main with an allowlist
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# Answer relayed control requests in main with an allowlist

See ADR-189 §2. Depends on ticket 1's types.

- `electron/backend/host-connection.ts` (`HostConnection` / `RemoteHostConnection`):
  - Every time the stream connects (including reconnects), send the `{ type: "enableControlRelay" }` stream command.
  - In `onStreamEvent`, route `controlRequest` to an injected `ControlRelaySink = (hostId: string, req: {method, path, body}) => Promise<{status: number, body: unknown}>`, and write `{ type: "controlResponse", id, status, body }` back on the stream.
  - If no sink is set, answer 503.
  - If the sink throws, answer 500 with `{error}`.
  - Thread the sink through `RemoteBackend` and the `BackendRegistry` spec or options, whichever the code's existing injection pattern suggests (see how `HookSink` reaches `HostHookFeed`).
- New `electron/control-relay.ts`:
  - `REMOTE_CONTROL_ALLOWLIST`: an array of `{ method, pattern: RegExp }` covering exactly the ADR's table:
    - `GET /context`
    - `GET /projects`, `GET /projects/:id`, `GET /projects/:id/branches`
    - `GET|POST|DELETE /projects/:id/workspaces`
    - `POST /projects/:id/workspaces/{batch,rename,hidden,reorder,folder}`
    - everything in `routes/folders.ts`
    - `GET /projects/:id/issues`, `GET /projects/:id/issues/:ref`
    - `GET|POST|DELETE /projects/:id/workspaces/issues`
    - `POST /projects/:id/issues`
    - `GET /agents`, `POST /agents`
    - Check the route files for the exact paths.
  - `isRemoteAllowed(method, pathname)`.
  - `handleRelayedControlRequest(deps: ControlDeps, hostId, req)`:
    - parse `new URL(req.path, "http://relay")`;
    - off the allowlist → `403 {error: "<METHOD> <pathname> isn't available from remote hosts"}`;
    - otherwise call `handleControlRequest({...deps, callerHostId: hostId}, method, url, json, async () => req.body ?? {})`, capturing the `json(status, body)` call;
    - return 404 if not handled.
- `electron/routes/types.ts` (or wherever `ControlDeps` lives): add an optional `callerHostId?: string`.
- `electron/webview-server.ts`: add a public `getControlDeps(): ControlDeps` returning the same merged deps `handleRequest` builds (factor the merge into one private method that both use).
- `electron/routes/context.ts`: when `deps.callerHostId` is set, restrict the cwd-fallback candidates to projects whose `hostId` matches. The pane-id path is unchanged.
- `electron/app-lifecycle.ts`: construct the sink as `(hostId, req) => handleRelayedControlRequest(webviewServer.getControlDeps(), hostId, req)` and pass it where ticket 1's plumbing expects it.
- Tests:
  - `control-relay.test.ts`: allowed vs refused routes, captured status and body, 404 when unhandled;
  - `context` route: a host-scoped cwd match;
  - host-connection: enable is sent on connect, and request → response.

## Files to touch
- `electron/backend/host-connection.ts` — enable on stream connect, handle `controlRequest`
- `electron/backend/remote-backend.ts`, `electron/backend/registry.ts` — sink plumbing
- `electron/control-relay.ts` — new allowlist and dispatcher
- `electron/routes/types.ts` — `callerHostId`
- `electron/routes/context.ts` — host-aware cwd match
- `electron/webview-server.ts` — `getControlDeps()`
- `electron/app-lifecycle.ts` — wiring
- matching `*.test.ts` files
