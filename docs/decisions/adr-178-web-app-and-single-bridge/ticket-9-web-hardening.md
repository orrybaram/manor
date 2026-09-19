---
title: Web hardening — the gaps ticket 6 found outside its files
status: in-progress
priority: high
assignee: sonnet
blocked_by: [6]
---

# Web hardening — the gaps ticket 6 found outside its files

Follow-up created from ticket 6's report. Each item is a place where the web
app would throw an unhandled rejection or show a lie; all are small.

## Server (`electron/remote-control/ws-handlers.ts`)

- `remoteControl.getStatus` and the `remoteControl.onStatus` broadcast are
  absent from the table, so `RemoteControlPage` on the web shows remote control
  as *off* while remote control is what let the browser in. Add the read and
  wire the status broadcast through `renderer-broadcast.ts` the way
  `preferences.changed` is. Reads only — `setEnabled`/`pair`/`revoke`/tunnel
  stay off the table (ticket 6 already made the page read-only on web).
- `preferences.set` — a `full` device may write preferences (D3); the reason it
  was off the slice-1 table was scope, not policy. Add it, in `MUTATING`, so
  theme/notification/general toggles work from a browser instead of rejecting.
  `keybindings.set`/`reset`/`resetAll` stay off (ticket 6 made that page
  read-only) but must not throw — see below.

## Stores

- `src/store/preferences-store.ts`, `src/store/keybindings-store.ts` — every
  fire-and-forget `window.electronAPI.*.set*(…)` gets a `.catch` that routes
  `BridgeUnavailableError` through the same once-per-session toast helper
  `app-store.ts` gained for `layout.save` (extract it to `src/lib/` if it is
  not already reusable) and rethrows anything else. No silent swallowing of
  real errors.

## Onboarding

- `dialog.openDirectory` is called directly from `App.tsx`, `WelcomeEmptyState`
  and `HomeEmptyState` (via `project-store.ts`'s `addProject` /
  `addProjectFromDirectory`). On the web, hide the "Add project" / "New
  project" buttons (remove, don't disable) and replace the empty-state copy
  with one line saying projects are added from the desktop app.

## External links

- `shell.openExternal` fire-and-forget call sites: `FeedbackModal`, `PortBadge`,
  `useTerminalLifecycle`, `terminal/file-link-provider.ts`,
  `utils/pr-notifications.ts`, GitHub/Linear issue detail views. Route them
  through one helper `src/lib/open-external.ts` that calls
  `shell.openExternal` on electron and `window.open(url, "_blank",
  "noopener")` on web (`ProjectItem.tsx` already does this inline — move that
  there). Where a `<Link>` from `ui/Link` fits, prefer it.

## Tests

- `ws-bridge.test.ts` — `remoteControl.getStatus` resolves for a `full`
  device; `preferences.set` is audited.
- Pure tests for the shared once-toast helper and `open-external` platform
  branch.

## Files to touch
- `electron/remote-control/ws-handlers.ts`, `electron/renderer-broadcast.ts`, the remote-control ipc/controller status emit site — status read + broadcast, `preferences.set`
- `src/store/preferences-store.ts`, `src/store/keybindings-store.ts`, `src/store/app-store.ts` — `.catch` via shared helper
- `src/lib/bridge-unavailable-toast.ts` (or wherever the helper lands) — extracted once-toast
- `src/App.tsx`, `src/components/**/WelcomeEmptyState*`, `src/components/**/HomeEmptyState*` — hide add-project on web
- `src/lib/open-external.ts` — new; call sites listed above
- tests as listed
