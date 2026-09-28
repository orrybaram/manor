---
title: Control relay listener and stream messages on the remote daemon
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Control relay listener and stream messages on the remote daemon

See ADR-189 §1.

- `electron/terminal-host/types.ts`:
  - `StreamEvent` gains `{ type: "controlRequest"; id: string; method: string; path: string; body: unknown }`, where `path` includes the query string.
  - `StreamCommand` gains `{ type: "enableControlRelay" }` and `{ type: "controlResponse"; id: string; status: number; body: unknown }`.
  - Document each with JSDoc like their neighbours.
  - Do NOT bump `TERMINAL_HOST_PROTOCOL`. Add a note to the change-history comment explaining why this is backward compatible: old daemons drop unknown stream commands (no default case), and the app only relays after `enableControlRelay`.
- `electron/paths.ts`: `remoteControlPortFile()` = `<remoteNamespaceDir>/control-port`, next to `remoteHookPortFile`.
- New `electron/terminal-host/control-relay-listener.ts`, modelled on `hook-listener.ts`:
  - Same structure: loopback `127.0.0.1:0`, 32-byte token, timing-safe comparison of the `x-manor-control-token` header (403 otherwise), port file `<port>\n<token>\n` at mode 0600 written with `writeFileAtomic`, and `MANOR_CONTROL_PORT_FILE` set in the env passed in (default `process.env`).
  - Export `CONTROL_TOKEN_HEADER`. Keep it in sync with `electron/mcp/http-client.ts`.
  - Accept any method. Read the body up to 1 MiB (413 over), and parse JSON if non-empty (400 on invalid JSON).
  - Take an injected `relay: (req) => Promise<{status, body}> | null`. `null` means no relay stream, so answer 503 `{ error: "Manor desktop is not connected to this host" }`.
  - Reply `application/json` with the status and body.
  - Electron-free: the daemon bundle imports it.
- In `electron/terminal-host/index.ts` (stream socket handling next to the `hookEvent` broadcast), implement the relay:
  - Track the relay stream: the most recent authenticated stream socket that sent `enableControlRelay`. Clear it when that socket closes.
  - `relay(req)`: if there is no relay stream, return null. Otherwise mint an id (`crypto.randomUUID()`), write the `controlRequest` event to that socket, and keep a pending map id → resolver.
  - Handle the `controlResponse` stream command by resolving the pending entry. Ignore unknown ids.
  - Time out each pending request after 30s with `{status: 504, body: {error: "Manor desktop did not answer in time"}}`.
  - When the relay socket closes, resolve all its pending requests with 503.
- `electron/terminal-host/daemon-role.ts`: `remoteRole.onStartup` creates and starts the listener with `portFile: remoteControlPortFile()`, next to the hook listener, and `bootstrap()` retries it the same way. The local role does not start it.
- Tests (vitest, next to the existing hook-listener and daemon tests):
  - listener: 403 without or with a wrong token; 503 when relay returns null; passes the relayed status and body through; 413 on an oversize body; the port file is written 0600 and the env var is set;
  - daemon: `controlRequest` reaches the enabled stream; the response resolves the request; timeout; close resolves with 503.

## Files to touch
- `electron/terminal-host/types.ts` — new StreamEvent/StreamCommand variants
- `electron/paths.ts` — `remoteControlPortFile`
- `electron/terminal-host/control-relay-listener.ts` — new
- `electron/terminal-host/index.ts` — relay stream tracking, pending map, `controlResponse` handling
- `electron/terminal-host/daemon-role.ts` — start the listener in the remote role
- matching `*.test.ts` files
