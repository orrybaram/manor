---
title: RemoteBackend implementing WorkspaceBackend over the bridge
status: todo
priority: critical
assignee: opus
blocked_by: [2, 5, 7]
---

# RemoteBackend implementing WorkspaceBackend over the bridge

Assemble the pieces into a working remote host.

Implement `electron/backend/remote-exec.ts`: an `Exec` (ticket 2) whose `file()`,
`stream()`, and `readFile()` route to the daemon's `exec` / `execStream` / `readFile`
(ticket 7) through a `TerminalHostClient` built on `SshTransport` (ticket 5).
`stream()`'s `cancel()` sends `execCancel`.

Implement `electron/backend/remote-backend.ts`:

```ts
export class RemoteBackend implements WorkspaceBackend {
  readonly pty: LocalPtyBackend;   // same class, bridged client
  readonly git: LocalGitBackend;   // same class, remote Exec
  readonly shell: LocalShellBackend;
  readonly ports: LocalPortsBackend;
}
```

The point is that no git/shell/ports *logic* is duplicated — only the `Exec` differs.
If a backend class turns out to have a genuinely local-only assumption (an absolute path
built from `os.homedir()`, an `execFileSync` left over from ticket 2), fix it there
rather than forking the class, and say what you changed in the commit body.

`connect()` runs `ensureRemoteHost` (ticket 6), then connects the client, then performs
the daemon `bootstrap` request (ticket 10 adds the request itself — call it defensively
and tolerate `error: unknown request type` until then). `disconnect()` disposes the
transport and tears down the ssh children.

Add a reconnect policy: if the ssh child exits while sessions are live, emit a typed
`hostDisconnected` event and attempt reconnect with backoff (1s, 2s, 4s, 8s, cap 30s).
Do not silently drop stream events — surface the gap so the renderer can resnapshot via
the existing `getSnapshot` path.

## Files to touch
- `electron/backend/remote-exec.ts` — new.
- `electron/backend/remote-backend.ts` — new.
- `electron/backend/types.ts` — add the `hostDisconnected` / `hostReconnected` event
  shape to `WorkspaceBackend` if not expressible through existing events.
- `electron/backend/index.ts` — export `RemoteBackend`.
- `electron/backend/__tests__/remote-backend.test.ts` — new; fake transport, assert git
  commands reach the wire unchanged and that reconnect backs off.
