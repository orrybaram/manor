---
title: Remote route allowlist and subset assertion
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Remote route allowlist and subset assertion

Define which of `electron/routes/`'s routes may ever be reachable from outside the
machine, as an allowlist that is checked by a test rather than by review discipline.

Create `electron/remote-control/allowlist.ts`:

```ts
/** Routes the remote-control listener serves. Additions here are a security decision. */
export const REMOTE_READ_ROUTES = [
  "GET /tasks",
  "GET /context",
  "GET /panes",
  "POST /sessions/read",
] as const;

/** Routes that can act. Gated per-device at runtime — see ticket 4. */
export const REMOTE_WRITE_ROUTES = ["POST /sessions/send"] as const;

export function remoteRouteTable(
  all: readonly Route[],
  allowWrites: boolean,
): Route[];
```

`remoteRouteTable` filters the real table from `electron/routes/index.ts` by
`` `${method} ${path}` ``. A route not named is **absent from the returned table**, not
403'd — the point is that no auth bug can reach it.

Add to `electron/routes/router.test.ts` (or a new `allowlist.test.ts`):

1. Every entry in both allowlists corresponds to a real route in `routes` — a typo'd or
   renamed path fails the build rather than silently shrinking the remote surface.
2. `remoteRouteTable(routes, true)` is a strict subset of `routes`.
3. The returned table contains no route whose path starts with `/projects`, `/issues`, or
   `/agents`, no pane/tab mutation, and no `DELETE` of any kind. Write
   this as an explicit deny-assertion so a future allowlist edit that widens the surface
   has to consciously delete a test line.

## Files to touch

- `electron/remote-control/allowlist.ts` — new.
- `electron/routes/index.ts` — export the `Route` shape if not already exported for reuse.
- `electron/remote-control/__tests__/allowlist.test.ts` — new.
