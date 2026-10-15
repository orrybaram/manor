---
title: E2E for the phone's drop grace (ADR-230 D5)
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# E2E for the phone's drop grace

ADR-231 D6, item D5. It needs no remote box: only the local relay and the
latency proxy.

## What to build

A new test in `tests/e2e/web-app.spec.ts`, or a new
`tests/e2e/phone-drop-grace.spec.ts` if `web-app.spec.ts`'s fixtures don't
fit.

- **Setup.** Start `startLatencyProxy(relay.url, 0)`
  (`tests/e2e/helpers/latency-proxy.ts`). Pair a phone with the desktop,
  rewriting the pairing link's relay host to the proxy, as
  `mobile-audit.spec.ts:272-274` does. Wait for the phone's top bar.
- **A blip.**
  - `proxy.dropAll()`. The sockets are destroyed, so the browser sees
    1006.
  - Poll for 3 s: `web-app-unreachable` is never visible.
  - Then a bridge call from the page (e.g. `projects.getAll`) succeeds.
- **A real drop.**
  - `proxy.outage()`.
  - Within 8 s `web-app-unreachable` is visible. With the 4 s grace and the
    redial backoff, it must not show before about 4 s; assert it isn't
    visible at 3 s.
  - A bridge call made from the page now settles (rejects, or resolves
    with an unavailable result) within 2 s, rather than hanging. Measure
    it with `Date.now()` inside `page.evaluate`.
- **Back.** `proxy.restore()`. The overlay goes within 30 s, and a bridge
  call succeeds.

If the "not before 4 s" check is flaky, because the redial's first refusal
races the timer, loosen it to "not visible at 2 s". Say why in a comment.

It runs in the normal Playwright run (not the remote harness), with
`pnpm build:web:relay` first, like the other relay specs.

## Verify

5 of 5 with `--repeat-each=5`. Check it fails on the base of ADR-230
(`b128a6fa`) for the "within 8 s" assertion, or explain in the commit
message why it would.

## Files to touch
- `tests/e2e/web-app.spec.ts` or `tests/e2e/phone-drop-grace.spec.ts` (new).
