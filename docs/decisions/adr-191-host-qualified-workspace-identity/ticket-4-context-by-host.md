---
title: /context matches workspaces by host plus path
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# /context matches workspaces by host plus path

GitHub issue #241. See ADR-191 §4.

- `electron/pane-context.ts`: `matchProjectByPath` takes the caller's host
  and considers only workspaces on that host.
- `electron/routes/context.ts`: the caller's host is `deps.callerHostId` for
  a relayed request (ADR-189). Otherwise it is the host that owns the calling
  pane (`SessionOwners`), or local. Apply it on every rung, including the 404
  candidate list, as ADR-189 already does for relayed requests. Rung 1
  resolves the pane's workspace key and matches host and path together.
- Tests: extend the pane-context and context-route tests. With the same path
  on a local and a remote project, a remote pane resolves to the remote
  project and a local pane to the local one. Single-host behavior is
  unchanged.

## Files to touch
- `electron/pane-context.ts` and its test.
- `electron/routes/context.ts` and `context.test.ts`.
- `electron/routes/types.ts`, if the route needs the session owners in `ControlDeps`.
