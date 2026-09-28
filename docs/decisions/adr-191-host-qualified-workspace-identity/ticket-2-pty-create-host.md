---
title: New terminals open on the host they were asked for
status: done
priority: high
assignee: opus
blocked_by: []
---

# New terminals open on the host they were asked for

GitHub issue #239. See ADR-191 §2.

- `pty:create` accepts an optional `hostId`. Validate it as a string and pass
  it through the preload bridge and `src/electron.d.ts`.
- `RoutedBackend.createOrAttach` routes by
  `sessions.ownerOf(id) ?? hostId ?? hostForPath(cwd)`. An existing session
  owner always wins, so an ADR-183 host move still reports the pane's real
  host.
- The renderer passes the host of the workspace the pane is created for:
  new tab, split, restore and prewarm. Use the owning project's `hostId` for
  now. Once #240 lands, it can come from the workspace key.
- Tests: extend the pty-host IPC tests. With the same path registered on a
  local and a remote project, a pane created with the remote host lands on
  the remote host. With no host, today's path fallback still applies.

## Files to touch
- `electron/ipc/pty.ts`: accept and validate `hostId`.
- `electron/backend/routed-backend.ts`: route by the explicit host before the path.
- `electron/preload.ts`, `src/electron.d.ts`: add the argument.
- Renderer pane-creation sites: pass the host. These are `src/hooks/useTerminalLifecycle.ts`
  (`create(spawnCwd, …)` through `useTerminalConnection`, used by `TerminalPane`), `src/store/project-store.ts`
  (the `pty.create` for a new workspace's first pane), and `src/hooks/useMiniTerminal.ts`.
  Prewarm (`src/App.tsx`) already passes a host.
- The pty IPC and routed-backend tests.
