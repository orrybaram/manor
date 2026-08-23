---
title: Installable client, so push works on iPhone
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Installable client, so push works on iPhone

Ticket 8 shipped Web Push and it is correct — VAPID keys, per-device subscriptions,
expiry pruning, no scrollback in the payload. It does not fire on an iPhone, because
iOS grants `Notification.requestPermission` and `PushManager.subscribe` **only to a site
the user has added to the Home Screen as a PWA**. `src/remote-client/index.html` has no
manifest, so Safari never offers the option, and `enablePush()` in
`src/remote-client/main.ts` returns quietly at its `Notification.permission` check.

Being told rather than checking is the whole premise of ADR-161. On the device the
feature exists for, it currently does not happen.

The serving side is already ready: `static.ts` has `.webmanifest` in `CONTENT_TYPES` and
`manifest-src 'self'` in the CSP. This is the client half.

- `src/remote-client/manifest.webmanifest`: `name`, `short_name`, `start_url: "./"`,
  `display: "standalone"`, `theme_color`/`background_color` matching the client's dark
  shell, and `icons` at 192 and 512 (plus a maskable variant).
- Icons committed as PNGs under `src/remote-client/`, copied by
  `vite.remote.config.ts` into `dist-electron/remote/`. No external requests, same rule
  as everything else in this client.
- `<link rel="manifest">` plus the iOS-specific `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style`, and `apple-touch-icon` tags in `index.html`.
- An in-client hint: when running in iOS Safari **not** in standalone mode
  (`navigator.standalone === false`) and no push subscription exists, show a dismissible
  line explaining that notifications need Share → Add to Home Screen. Do not nag — one
  line, dismissible, remembered in `localStorage`.
- `enablePush()` should distinguish "this device cannot do push" from "this device has
  not been asked yet", so the hint can be accurate rather than universal.

Note the interaction with ticket 13: installing to the Home Screen pins the origin. A
cloudflared quick tunnel hands out a new hostname on every start, which orphans the
installed app, its stored token, and its push subscription. This ticket is worth doing
regardless — Tailscale users get a stable host today — but the two land best together.

Tests: manifest is emitted into `dist-electron/remote/` by the build; `serveClientAsset`
returns it with `application/manifest+json`; the hint renders only in the
non-standalone-iOS case.

## Files to touch

- `src/remote-client/manifest.webmanifest` — new.
- `src/remote-client/icons/` — new; 192, 512, maskable.
- `src/remote-client/index.html` — manifest link and Apple meta tags.
- `src/remote-client/main.ts` — push capability detection, install hint.
- `src/remote-client/styles.css` — the hint.
- `vite.remote.config.ts` — copy manifest and icons into the output.
- `electron/remote-control/__tests__/static.test.ts` — manifest content type.
