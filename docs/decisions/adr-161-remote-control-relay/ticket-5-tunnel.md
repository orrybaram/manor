---
title: Tunnel lifecycle — Tailscale or cloudflared, user-initiated
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Tunnel lifecycle — Tailscale or cloudflared, user-initiated

The listener is loopback-bound. Reaching it from a phone needs a tunnel, which Manor
detects but never installs, and starts only on an explicit user action.

`electron/remote-control/tunnel.ts`:

- `detect(): Promise<{ tailscale: boolean; cloudflared: boolean }>` using the existing
  `backend.shell.which()` rather than a new `which` implementation.
- `start(kind, port): Promise<{ url: string }>` — spawn `tailscale serve` or
  `cloudflared tunnel --url http://127.0.0.1:<port>`, parse the assigned hostname from
  stdout/stderr, and resolve when it appears (30s timeout, then kill and error).
- Prefer Tailscale when both are present: the device is already authenticated at the
  network layer, which makes the bearer token a second factor instead of the only one.
- `stop()` kills the child and waits for exit. The tunnel **must** stop when Manor quits —
  hook `app-lifecycle`'s shutdown path, and handle the child dying on its own by emitting
  a state change so the UI stops claiming to be reachable.
- Emit a typed status (`stopped | starting | running | failed`) with the URL when running.

Starting a tunnel makes a local surface publicly reachable. That is an outward-facing
action: it requires an explicit confirmation naming what becomes reachable (ticket 6
owns the dialog), and Manor must never start one at launch, on restore, or as a side
effect of anything else.

Tests: detection with a faked `which`; URL parsing for both tools' real output formats;
timeout kills the child; `stop()` is idempotent; unexpected child exit emits `failed`.

## Files to touch

- `electron/remote-control/tunnel.ts` — new.
- `electron/app-lifecycle.ts` — stop the tunnel on quit.
- `electron/remote-control/__tests__/tunnel.test.ts` — new.
