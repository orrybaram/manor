---
title: Delete the control-server barrel; derive OWNED_PREFIXES
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Delete the control-server barrel; derive OWNED_PREFIXES

Structural deletion #12. Behavior-preserving.

## The problem

`electron/control-server.ts` is 91 lines: a route table, a hand-maintained
prefix list, a re-export block, and a 5-param pass-through.

Grepped consumers of the module — **all of them**:

| Importer | Imports |
|---|---|
| `electron/webview-server.ts:16` | `handleControlRequest` |
| `electron/preload.ts:2` | `type AppCommand`, `type AppCommandResult` |
| `electron/__tests__/mcp-webview-server.test.ts:45-46` | `requestRenderer`, `type AppCommand`, `type AppCommandResult` |

Zero consumers of the re-exported `proxyToRenderer`, `startAgent`,
`runSetupScript`, `notifyProjectsChanged`, `RendererResponse`, `ControlDeps`,
`Json`, `ReadBody`, `Route`, `RouteContext` (and `rendererErrorStatus`, deleted
in ticket 4). Ticket 5 of ADR-151 said "preserve every export"; the result is a
barrel of dead names. `webview-server.ts:241-246` even builds the deps object as
an inline literal rather than importing `ControlDeps`.

## What to do

### 1. `renderer-bridge.ts` moves up

`electron/routes/renderer-bridge.ts` → `electron/renderer-bridge.ts`. Its own
header admits it lives under `routes/` only to break a cycle — and that cycle
exists solely because the table lives in `control-server.ts`. It is not a route.

Update `electron/routes/panes.ts`, `electron/routes/agents.ts`, and
`electron/routes/projects.ts` to import from `../renderer-bridge`.
Point `preload.ts:2` and `__tests__/mcp-webview-server.test.ts:45-46` at
`./renderer-bridge` / `../renderer-bridge` directly.

### 2. The table moves to `electron/routes/index.ts`

Move the `routes` array and `handleControlRequest` there. Derive the prefixes
from the table rather than hand-listing them:

```ts
const OWNED_PREFIXES = new Set(routes.map((r) => r.path.split("/")[1]));
```

`dispatch`'s `ownedPrefixes` param becomes `ReadonlySet<string>`; its
`.includes` becomes `.has`. This kills a drift class: adding a route under a new
prefix and forgetting the list currently makes `dispatch` return `false`, the
request falls through to `webview-server.ts`'s bare 404, and no test can catch it
because the list and the table are independent.

### 3. Delete `electron/control-server.ts`

`webview-server.ts:16` imports `handleControlRequest` from `./routes`.

### 4. Correct the route-ordering comments

Three comments assert an ordering hazard that does not exist:

- `control-server.ts:52-56` (deleted with the file) and `routes/projects.ts:120-121`
  claim `/projects/:projectId/workspaces/batch` must precede the `/workspaces`
  collection. It has **4** path segments; `/workspaces` has **3**. `matchPath`
  returns `null` on any arity mismatch (`router.ts:31`). They can never both match.
- `routes/panes.ts:21-23` claims `/panes/split` must precede `/panes/:paneId`.
  One is POST, one is DELETE, and `dispatch` **continues** on a method mismatch
  (`router.ts:72`) rather than bailing — so reversing them changes nothing. The
  comment half-admits this ("They happen not to collide today").

Delete both per-site comments. State the real rule once in `router.ts`'s header:
*order matters only between two rows with the same method **and** the same
segment count, where one's static segment is the other's `:param`.*

Then make the discipline unnecessary — add to `electron/routes/router.test.ts`:

```ts
it("has no two rows that can both path+method-match the same request", () => {
  // for each pair of rows with equal method and equal segment count,
  // assert no synthesized path satisfies both
});
```

## Files to touch
- `electron/renderer-bridge.ts` — moved from `routes/`
- `electron/routes/index.ts` — new: the table, derived `OWNED_PREFIXES`, `handleControlRequest`
- `electron/routes/router.ts` — `ownedPrefixes: ReadonlySet<string>`; the real ordering rule in the header
- `electron/routes/router.test.ts` — add the no-ambiguous-rows test
- `electron/routes/panes.ts`, `agents.ts`, `projects.ts` — import path; delete the two false comments
- `electron/control-server.ts` — **deleted**
- `electron/webview-server.ts`, `electron/preload.ts`, `electron/__tests__/mcp-webview-server.test.ts` — import paths

## Verify
`pnpm typecheck` clean, `pnpm test` green. `git ls-files electron/control-server.ts`
returns nothing. Every existing route still resolves — `router.test.ts` covers it.
