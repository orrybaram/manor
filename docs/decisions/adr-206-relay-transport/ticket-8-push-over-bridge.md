---
title: Push over the bridge
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Push over the bridge

ADR-206 D7. A relay-paired web app can't call `POST /push/subscribe`, so give
the bridge an entry for it and give the web app a service worker.

## What to build

- **Bridge handler** `remoteControl.subscribePush(subscription)` and
  `remoteControl.vapidPublicKey()` — device callers only (refuse `local`),
  storing the subscription on the calling device (`connection.deviceId`) via
  the existing `PushManager` / device store path the HTTP route uses. Share
  that code; do not duplicate it.
- **Web app:** a service worker (`src/web/sw.ts`, built by
  `vite.web.config.ts` to `sw.js` under the base) that shows notifications and
  focuses/opens the app on click — model it on `src/remote-client/sw.ts`.
  An "Enable notifications" control in the phone chrome (ADR-181) that
  requests permission from a user gesture, subscribes with the VAPID key, and
  calls the handler. On iOS Safari without standalone mode, show "Add to Home
  Screen to get notifications" instead.
- `WEB_CSP` already allows `worker-src 'self'`.

## Tests

Handler unit test (device stores subscription; local caller refused). The
service worker and permission flow are verified by hand; note it in the PR.

## Files to touch
- `electron/bridge/handlers/remote-control.ts`, `electron/remote-control/push.ts`
- `src/web/sw.ts` — new; `vite.web.config.ts`
- phone chrome component from ADR-181
