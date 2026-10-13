---
title: Renderer-importable route manifest and shared host rewrite
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Renderer-importable route manifest and shared host rewrite

ADR-228 D1 ("one source of route rules", "one rewrite, two callers"). This is
a refactor only: no behavior changes.

## Do
- **Route manifest.**
  - Create `electron/bridge/routes.ts`. It must be pure: no imports beyond
    types and `src/lib/workspace-key.ts`.
  - Move `RouteRule`, `LOCAL_ROUTE` and the `by*` factories there from
    `electron/bridge/method.ts`. `method.ts` re-exports them.
  - Export `ROUTES: Record<string, RouteRule | "merge" | "home">`, keyed
    `ns.method`:
    - every method that has a `route` today gets its rule;
    - the merged reads (`projects.getAll`, `layout.getAll`,
      `layout.getLastActive`, `agents.get*`, `agents.getPaneStatuses`,
      `projects.getRemote`) get `"merge"`;
    - every other method that is `LOCAL_ROUTE` today gets `"home"`.
  - Change the table entries to read their `route` from `ROUTES`, or assert
    against it. Pick whichever keeps `method(...)` call sites readable.
  - Extend the surface test (`electron/bridge/__tests__/`, next to the
    existing routed-namespace check) so it fails when a table's `route`
    and `ROUTES` disagree.
  - It must also fail when a renderer-callable method in a routed namespace
    is missing from `ROUTES`.
- **Shared rewrite.**
  - Move the pure rewrite out of `electron/backend/host-proxy.ts:655-715`
    into `electron/bridge/host-rewrite.ts`: `keyFor`, `toDesktop`,
    `toHostArgs`, `toDesktopResult` and the per-method special cases. Each
    function takes `hostId` as a parameter.
  - `HostProxy` imports it.
  - Unit-test the module directly (key ↔ bare path, `local` ↔ hostId,
    `layout.getAll` and `getLastActive` results).
- Both new modules must be importable from `src/` without pulling in Node or
  Electron. Add them to the bundle check that keeps the renderer
  Electron-free, if one covers `src/` imports of `electron/bridge/*`.
  Otherwise add a small test that imports them under a DOM-like env.

## Files to touch
- `electron/bridge/routes.ts` (new)
- `electron/bridge/host-rewrite.ts` (new), plus a test
- `electron/bridge/method.ts`: re-export
- `electron/bridge/handlers/{projects,agents,integrations,chat,layout,pty,...}.ts`:
  take routes from the manifest
- `electron/backend/host-proxy.ts`: use `host-rewrite.ts`
- the bridge surface test
