---
title: Add remote-bridge mode to the daemon entry point
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Add remote-bridge mode to the daemon entry point

The daemon entry (`electron/terminal-host/index.ts`) currently always starts the socket
server. Add an argv mode so the same binary can act as the remote end of an ssh stdio
bridge. This mirrors herdr's `src/remote/host_unix.rs`.

When invoked as `manor-host remote-bridge [--stream]`:

1. Ensure the daemon is running on *this* machine. Reuse the existing spawn/detect path;
   if the socket is absent, spawn the daemon detached and wait for the socket to appear
   (5s timeout, poll ~50ms). If it is present, proceed.
2. Read the token file.
3. Write exactly one line of NDJSON to stdout as a preamble:
   `{"type":"bridgeHello","token":"<token>","daemonVersion":"<version|null>"}\n`
4. Connect to the daemon unix socket (the control socket; `--stream` is informational
   for logging only since both use the same socket path today).
5. Pump bidirectionally and transparently: stdin → socket, socket → stdout. Flush on
   every chunk. On stdin EOF, half-close the socket write side. Exit when either
   direction closes.

Handle `EPIPE` quietly. Write any diagnostics to **stderr only** — stdout carries
protocol bytes and must not be polluted.

Also add `manor-host --version` printing `process.env.MANOR_VERSION ?? "unknown"` and
exiting 0, which the bootstrap step (ticket 6) uses for version comparison.

Add a test that spawns the entry in bridge mode against a temp-dir daemon and asserts
the `bridgeHello` preamble arrives followed by a working `ping`/`pong` round trip.

## Files to touch
- `electron/terminal-host/index.ts` — argv dispatch before `setup()`; `remote-bridge`
  and `--version` modes.
- `electron/terminal-host/bridge.ts` — new, the stdio↔socket pump and daemon-ready wait,
  kept separate so it is unit-testable.
- `electron/terminal-host/__tests__/bridge.test.ts` — new.
