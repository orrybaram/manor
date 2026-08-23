---
title: Extract HostTransport from TerminalHostClient
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Extract HostTransport from TerminalHostClient

`electron/terminal-host/client.ts` hardcodes how it reaches the daemon: unix socket
paths derived from `~/.manor/daemon/`, reading the token file with `fs`, and spawning
the daemon process. Everything else in that class — NDJSON framing, the request mutex,
the pending-request map, the version handshake, stream event dispatch — is
transport-independent and must not change.

Extract the transport concern:

```ts
// electron/terminal-host/transport.ts
export interface HostTransport {
  ensureRunning(version?: string): Promise<void>;
  connectControl(): Promise<Duplex>;
  connectStream(): Promise<Duplex>;
  authToken(): Promise<string>;
  dispose(): Promise<void>;
}
```

Implement `LocalTransport` in `electron/terminal-host/transport-local.ts` containing
exactly today's logic moved verbatim: `daemonDir`/`SOCKET_PATH`/`TOKEN_PATH`/`PID_PATH`
getters, stale-daemon migration (`_migratedOldDaemons`), daemon spawn, socket connect.

`TerminalHostClient`'s constructor takes an optional transport defaulting to
`new LocalTransport()`, so every existing call site is untouched. `net.Socket` uses
inside the client narrow to `Duplex` where possible.

**This is a pure refactor.** The daemon integration tests
(`electron/terminal-host/daemon.integration.test.ts`, `client.test.ts`, `e2e.test.ts`)
must pass without modification other than construction-signature updates. If any test
reaches into the client's private socket internals, adapt minimally.

## Files to touch
- `electron/terminal-host/transport.ts` — new, the interface.
- `electron/terminal-host/transport-local.ts` — new, `LocalTransport` with logic moved
  from `client.ts`.
- `electron/terminal-host/client.ts` — accept a transport, delete the moved code, keep
  framing/mutex/handshake/dispatch exactly as-is.
- `electron/terminal-host/client.test.ts` — construction updates only.
