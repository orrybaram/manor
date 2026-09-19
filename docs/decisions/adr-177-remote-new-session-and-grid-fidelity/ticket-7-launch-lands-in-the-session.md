---
title: A launch lands in the session it started
status: done
priority: high
assignee: sonnet
blocked_by: [3, 6]
---

# A launch lands in the session it started

Found by ticket 6's e2e, and it makes the ADR's own claim false today.

`mountNewSession()`'s launch handler does a single, immediate `GET /agents`
re-read after `POST /agents` returns, and matches the response's `paneId`
against the agent rows. A freshly spawned process has not reported `SessionStart`
to the hook relay yet, so that read consistently comes back without the new row:
the client falls back to `backToList()` and the session appears in the list a
moment later. The launch works; landing in it does not. ADR-177 says a launch
"lands you where you would have gone anyway", and the e2e currently works around
the gap by tapping the row the way a user has to.

## The fix

Do not race the relay — remember the launch and let the refresh that was already
coming resolve it.

- Keep a module-level pending launch (the `paneId` the launch returned, and
  nothing else). Set it when `POST /agents` succeeds.
- In `loadAgents()`, after `agents` is replaced: if a pending launch matches an
  agent's `paneId`, clear it and `openSession(agent)`. `loadAgents()` is already
  driven by both the SSE `status` event and the 5s list poll, so the new row
  opens as soon as either notices it — no bespoke retry loop, no second timer.
- Give it a bounded life: a pending launch that nothing matches within ~30s is
  dropped, so a launch that never produced a session cannot yank the user into a
  transcript minutes later while they are reading something else.
- Only auto-open while the user has not navigated away by hand. If they have
  already opened another session (`openAgentId` is set to something else), drop
  the pending launch rather than hijacking their screen.
- The immediate `loadAgents()` after a successful launch stays — when the relay
  is quick it still lands in one hop, and the pending launch simply resolves on
  that call.

Keep the existing notice ("Launched.") and keep going back to the list as the
immediate post-confirm destination; the auto-open is what happens next, not
instead.

## Tests

`tests/e2e/remote-control.spec.ts`, the `launching a new session from the phone`
case: remove the accommodation that taps the session row when auto-navigation did
not happen, and assert the claim directly — after confirming the launch, the
client ends up on that session's transcript on its own. That assertion is the
thing that was untrue; it must be the thing the test checks.

## Files to touch
- `src/remote-client/main.ts` — the pending launch, its resolution in `loadAgents()`, its expiry
- `tests/e2e/remote-control.spec.ts` — assert auto-open instead of working around its absence
