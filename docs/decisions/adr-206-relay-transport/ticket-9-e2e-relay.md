---
title: E2E — pair and drive a terminal over a local relay
status: done
priority: high
assignee: opus
blocked_by: [4, 5, 6, 7, 11, 12]
---

# E2E — pair and drive a terminal over a local relay

ADR-206. Prove the whole path, and prove the relay is blind.

## What to build

`tests/e2e/relay.spec.ts`:

- Start the relay locally (`wrangler dev` via `relay:dev`, or `unstable_dev`
  from wrangler in the fixture) with a local R2 holding this build's
  `build:web:relay` output. Launch Manor with `MANOR_RELAY_URL` pointing at it.
- Enable remote control, start the relay, pair via relay at `full`, open the
  pairing URL in a Playwright page.
- Drive a live terminal: type a marker string `relay-e2e-<random>`, see the
  output in the browser, desktop `cols` unchanged (follower rule).
- **Blindness:** run the relay with a debug var that appends every forwarded
  payload to a file (only honoured under `wrangler dev`); assert the marker
  and the device token appear in none of them.
- Revoke the device → browser shows the pairing screen. Stop the relay →
  browser shows "not reachable"; start again → it reconnects on its own.
- Version redirect: pair with a URL naming a different version that exists in
  local R2 → lands on the current version.

## Files to touch
- `tests/e2e/relay.spec.ts` — new; fixtures under `tests/e2e/`
- `relay/src/room.ts` — the dev-only payload log
