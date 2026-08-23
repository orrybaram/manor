---
title: Mobile web client
status: todo
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# Mobile web client

A single static page served by the remote listener at `/`, built into
`dist-electron/remote/`. Phone-first layout. No external requests of any kind — no CDN
fonts, no analytics, no remote images; the page must work over a tunnel with a strict
origin and nothing else reachable.

**Token handling.** On first load, read the token from the URL fragment, store it in
`localStorage`, and immediately strip the fragment via `history.replaceState` so it does
not linger in the address bar or history. Every request sends
`Authorization: Bearer <token>`. On 401, clear storage and show a "pair this device
again" state rather than retrying.

**Views.**
- Session list: label, project, agent status from the existing `AgentStatus` union
  (`idle` / `thinking` / `working` / `complete` / `requires_input` / `error` /
  `responded`). Sort blocked-first — `requires_input` and `error` at the top, since being
  told what needs attention is the whole point.
- Session detail: scrollback via `POST /sessions/read`, monospace, preserving ANSI-stripped
  text. Do not attempt full terminal emulation.
- Send box, only when the device holds the capability. Before sending, show a
  confirmation with the exact text and the target session name, and send
  `confirmed: true` (ticket 4 rejects sends without it).

**Live updates.** `EventSource` against `GET /events`. On error, fall back to polling
`GET /agents` every 5s and retry the stream with backoff.

Add the build as a vite entry writing to `dist-electron/remote/`, following the pattern
the other standalone entries use in `vite.config.ts`.

## Files to touch
- `src/remote-client/` — new; the page, its styles, and its entry.
- `vite.config.ts` — build entry emitting to `dist-electron/remote/`.
- `electron/remote-control/server.ts` — serve the built assets at `/` with correct
  content types and a restrictive CSP header.
