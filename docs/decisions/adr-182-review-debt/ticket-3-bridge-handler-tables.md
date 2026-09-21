---
title: Bridge namespaces export their own tables with ctx-first handlers
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Bridge namespaces export their own tables with ctx-first handlers

ADR-182 D3. `electron/bridge/handlers.ts` (1268 lines) is about 115 identity wrappers over `electron/bridge/handlers/*.ts`, plus four string-keyed rule lists.

## Handler signature and context
- Every handler function in `electron/bridge/handlers/*.ts` takes `(ctx: HandlerCtx, ...wireArgs)`, where `HandlerCtx = { deps: IpcDeps; caller: { id: string; callerClass: "local" | "device" } }`.
- Rename `IpcDeps` to `HostDeps` if cheap. Ticket 10 unifies it with `ControlDeps`, so a type alias is fine for now.

## Per-namespace tables
- Each namespace file exports a table, e.g. `export const pty = { write: method(ptyWrite), close: method(ptyClose, { mutating: true }), consumePrewarmed: method(ptyConsumePrewarmed, { localOnly: true }) }`.
- `method(fn, rules?)` is a tiny helper in `electron/bridge/method.ts`.
- `handlers.ts` becomes `export const HANDLERS = flatten({ pty, layout, projects, … })` plus derived rule sets:
  - `MUTATING_METHODS`, `SECRET_FIRST_ARG_METHODS` and `LOCAL_ONLY_METHODS` are derived by filtering the tables.
  - Keep the existing export names so `server.ts` and its tests change little.
  - Keep the "why" of each rule as a short comment beside the method, not in a 110-line list.

## Caller identity through ctx
- `server.ts` dispatch builds `ctx` from the connection and calls `fn(ctx, ...args)`.
- Delete:
  - `ORIGIN_ARG_COUNTS` and the argument padding (`server.ts:~219-233`)
  - `viewerOf` and the `LayoutOrigin` round-trip
  - all optional `origin?` parameters
  - the dead fallbacks (`handlers.ts:327` `isDesktopAttached` branch, `:471` `origin ??`)
- If `isDesktopAttached` then has no production users, delete it too.
- The `to === null ? publishRendererBroadcast : publishToRenderer` branches in `handlers/projects.ts:95`, `handlers/branches-diffs.ts:170` and `electron/persistence.ts:308` collapse. Callers always know the caller now; a single `publish(to: string | null, …)` is fine.

## `layout.reportViewport`
- Drop the self-reported `rendererId` argument; use `ctx.caller.id`.
- Delete its duplicate claim-stripping (the store already does it) and the `as PersistedDefaultViewport` cast.
- Update the renderer caller and `electron.d.ts`.

## Local-only rule shared with the browser
- Move the local-only method list into a dependency-free module, e.g. `electron/bridge/local-only.ts` exporting a `const` tuple.
- The namespace tables and `src/bridge/unavailable.ts` `SERVED_HERE` both import it.
- Add a type assertion that every local-only method has a browser answer.

## Scope and done criteria
- Update every test under `electron/bridge/__tests__/` (and the IPC tests) for the new signature. No behavioural change.
- `handlers.ts` must end under 150 lines.

## Files to touch
- `electron/bridge/handlers.ts`, `electron/bridge/handlers/*.ts`, `electron/bridge/server.ts`, `electron/bridge/method.ts` (new), `electron/bridge/local-only.ts` (new), `electron/bridge/types.ts`
- `electron/persistence.ts` (publish branch), `src/bridge/unavailable.ts`, `src/electron.d.ts` (reportViewport)
- the `electron/bridge/__tests__/*` files
