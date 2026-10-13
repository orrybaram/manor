---
title: Renderer server set and router behind window.electronAPI
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Renderer server set and router behind window.electronAPI

ADR-228 D1, D2, D3 and D6 (renderer side). This is the core of the slice. It
lands with **only the home server** in the set on both platforms. Behavior
must not change until tickets 5 and 7 add servers.

## Do
- **`src/bridge/server-set.ts`.**
  - Entries hold:
    - `{id, bridge, reachability, hello: {name, hostServer, version, capabilities}}`;
    - `add(id, transport)`, `remove(id)`, `home()`, `get(id)`;
    - a subscribe API for React (`useServers()`).
  - Move the singletons here: `ConnectionFacts` from `src/bridge/connection.ts`,
    and the reachability and outcome state from `src/bridge/install-web.ts`.
  - Keep `useConnection()` as a thin selector over the home entry, so
    existing callers keep compiling. Mark it for removal where a caller
    really means "this host".
- **`src/bridge/router.ts`.** `createRouter(set, resolver): ElectronAPI`.
  - **Routed** (`ROUTES` rule): resolve the host from the named argument with
    `resolver`, then use the source rule (D3). The resolver reads
    `project-store`, `app-store` layouts, `agent-store` and
    `remote-pane-store`. Rewrite with `host-rewrite.ts`, call, and rewrite
    the result.
  - **Merge:** call every reachable server, drop entries for a host whose
    source is a different server (D3), and merge.
    - Stamp renderer host ids (D2).
    - Groups come from the desktop's answer (D3).
  - **Home:** pass through.
  - **Subscriptions:** fan out to every server, and replay them on `add`.
    `pty.*` and `chat.*` go only to the pane's source, keyed by
    `(serverId, paneId)`. Refuse a pane id seen on two servers.
  - **A write to a host with no reachable source** throws
    `BridgeUnavailableError` with code `unavailable:host-away`.
  - **Last-known:** keep the last merged answer per server in memory.
    IndexedDB persistence is for the phone, in ticket 7.
- **`src/bridge/resync.ts`.** A resumed hello on any server emits the resync.
- **Installation.**
  - `install-desktop.ts` and `install-web.ts` build the set with the home
    server only, and set `window.electronAPI = createRouter(...)`.
  - Stores still import before `App`. The router must answer calls during
    store `create()`, before any host joins.
- **Tests.** Unit tests with fake transports covering:
  - routed calls reaching the right server, with rewritten args and results;
  - merge and dedupe by source;
  - subscription replay on `add`;
  - pane-keyed subscriptions;
  - host-away refusals;
  - per-server resync.

  The existing renderer test suite must pass unchanged.

## Files to touch
- `src/bridge/server-set.ts` (new), `src/bridge/router.ts` (new), tests
- `src/bridge/client.ts`, `src/bridge/connection.ts`, `src/bridge/resync.ts`
- `src/bridge/install-desktop.ts`, `src/bridge/install-web.ts`
- `src/store/{project-store,app-store,agent-store,remote-pane-store}.ts`:
  only to export the lookups the resolver needs
