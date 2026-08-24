---
title: A tunnel that dies while nobody is watching
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# A tunnel that dies while nobody is watching

`TunnelManager` handles the child dying correctly as far as it goes: the status moves to
`failed`, the badge turns red, and the UI stops claiming you are reachable. That is the
right behaviour for a user sitting in front of the app. It is close to useless for the
case the feature exists for, where the red badge is on a screen in an empty room and the
phone simply stops working with no explanation.

- Restart the child on an **unexpected** exit — one not caused by `stop()` — with a capped
  exponential backoff and a bounded number of attempts, after which it stays `failed` for
  good. A tunnel flapping forever is its own hazard.
- Keep `stop()` authoritative: a user-initiated stop must never be retried, and disabling
  remote control must not race a pending restart.
- A restarted quick tunnel comes back on a _different_ hostname, which invalidates every
  paired device. Do not restart a quick tunnel silently as though nothing changed —
  either surface it loudly, or restrict auto-restart to stable-hostname tunnels
  (Tailscale, or the named tunnel from ticket 13). Decide this explicitly; it is the
  reason this ticket is not a two-line change.
- Surface the failure where the user actually is: a desktop notification when a tunnel
  fails and cannot be restored, using the existing notification path rather than a new
  one.

Tests: an unexpected exit triggers a restart; `stop()` during backoff cancels it; attempts
are capped and the terminal state is `failed`; a user-initiated stop is never retried.

## Files to touch

- `electron/remote-control/tunnel.ts` — restart policy.
- `electron/remote-control/controller.ts` — notification on terminal failure.
- `electron/remote-control/__tests__/tunnel.test.ts` — the cases above.
