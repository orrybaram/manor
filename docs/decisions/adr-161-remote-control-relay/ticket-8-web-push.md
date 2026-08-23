---
title: Web Push on requires_input
status: done
priority: medium
assignee: opus
blocked_by: [3, 7]
---

# Web Push on requires_input

Checking is a worse product than being told. Push a notification when a session goes
`requires_input` or `error`.

Manor already computes this exact transition for the dock badge and OS notifications —
`maybeSendNotification` in `electron/app-lifecycle.ts` and `electron/notifications.ts`.
This is a **second sink on the existing signal**, not new detection. Do not add a second
status-transition path; hook the existing one.

- VAPID key pair generated once and stored via `safeStorage` alongside the device store
  (`electron/paths.ts` gets `remoteVapidFile()`, `manorDataDir()`, mode 0600).
- `POST /push/subscribe` (token-authenticated, allowlisted) stores a device's push
  subscription against its `RemoteDevice`. Subscriptions die with the device on revoke.
- Send on transition into `requires_input` or `error` only. Include session label and
  project; **never** include scrollback content in the payload — a push payload reaches
  the OS notification shade and routinely would carry secrets.
- Respect the existing notification preferences in `PreferencesManager` rather than
  inventing a parallel setting; a user who muted notifications should not get pushes.
- Handle expired subscriptions (410/404 from the push service) by dropping them silently.
- Service worker in `src/remote-client/` handling `push` and `notificationclick`
  (focus/open the session detail view).

Tests: a transition to `requires_input` sends exactly one push per subscribed device; a
transition to `working` sends none; a revoked device receives nothing; an expired
subscription is dropped; muted preferences suppress the send.

## Files to touch

- `electron/remote-control/push.ts` — new; VAPID keys, subscription store, send.
- `electron/remote-control/server.ts` — `POST /push/subscribe`.
- `electron/remote-control/allowlist.ts` — add the subscribe route.
- `electron/app-lifecycle.ts` — attach the push sink to the existing transition signal.
- `src/remote-client/sw.ts` — new; service worker.
- `electron/paths.ts` — `remoteVapidFile()`.
- `electron/remote-control/__tests__/push.test.ts` — new.
