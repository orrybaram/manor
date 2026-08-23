---
title: Settings UI — enable, pair devices, show exposure
status: todo
priority: high
assignee: sonnet
blocked_by: [2, 5]
---

# Settings UI — enable, pair devices, show exposure

The user needs to turn remote control on, pair a phone, and always be able to tell
whether they are currently reachable from outside.

1. **Enable toggle** — off by default. Turning it on starts the listener (ticket 3) but
   not the tunnel.
2. **Start tunnel** — separate, explicit action. Show a confirmation that names what
   becomes reachable ("your agent list, session output, and — for devices you allow —
   the ability to type into sessions") and which tool will be used. Not a generic
   "are you sure".
3. **Pair a device** — label field, a "allow this device to send input" checkbox
   (**unchecked by default**), then show the QR code for
   `https://<tunnel-host>/#<token>` plus the raw token as copyable text, with a clear
   "this is shown once" note. Requires a running tunnel to produce a useful URL.
4. **Device list** — label, created, last seen, send capability, and a revoke action per
   device. Revoke takes effect immediately.
5. **Persistent exposure indicator** — while a tunnel is live, show it somewhere always
   visible, not only inside settings. A user must never be surprised that they are
   reachable.
6. **Send confirmation** is client-side in ticket 7; this ticket only owns the desktop UI.

Per `.claude/rules/ui-components.md`, use `Button` from `src/components/ui/Button/Button`
and `Tooltip` from `src/components/ui/Tooltip/Tooltip` — never a raw `<button>`. Check
`src/components/ui/` for an existing switch/checkbox/input before adding one; the project
already depends on `@radix-ui/react-switch` and `@radix-ui/react-checkbox`.

Generate the QR code locally — no external service, no CDN. Add a small QR dependency or
render one inline; do not fetch an image from a third party with a token in the URL.

## Files to touch
- `src/components/` — remote-control settings panel (follow the existing settings patterns).
- `src/components/` — exposure indicator in the persistent chrome.
- `electron/preload.ts` + `electron/ipc/` — IPC for enable/disable, pair, revoke, list,
  tunnel start/stop, and status subscription.
- `package.json` — QR generation dependency, if one is added.
