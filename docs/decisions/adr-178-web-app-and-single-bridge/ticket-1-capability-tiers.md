---
title: Capability tiers — read, send, full — replace canSend
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Capability tiers — read, send, full — replace canSend

ADR-178 D3. A paired device's power is one of three tiers, not a boolean. For
`read` and `send` nothing observable changes. For `full`, the remote route
table is the *whole* table, every non-GET is audited, and nothing needs
`confirmed: true`.

## Model

- `electron/remote-control/devices.ts` — `canSend: boolean` →
  `capability: "read" | "send" | "full"` on `RemoteDevice`, `RemoteDeviceInfo`
  and the stored record. **Migrate on load**: a stored record with `canSend`
  and no `capability` maps `true → "send"`, `false → "read"`; write back in the
  new shape. `pair(label, capability)`. Export a `Capability` type and a
  `canSend(capability)` helper (`send` or `full`) so the send-gated paths keep
  one expression.
- `electron/remote-control/allowlist.ts` — `allowedKeys(capability)`:
  `read` → read routes; `send` → read + write; `full` → **null** meaning "do
  not filter". `remoteRouteTable(all, capability)` returns `all` unchanged for
  `full`. Update the file comment: the allowlist governs two of three tiers.
- `electron/remote-control/server.ts` — build the table from
  `device.capability`. In `guardWrites`, for a `full` device: every route whose
  method is not `GET` gets an audit line (`routeKey` + `target` from
  `body.target ?? body.workspacePath ?? params`, no text, no hash) and **no**
  `confirmed` requirement. The existing `send` gates (`GUARDED_WRITE_ROUTES`,
  `confirmed`, workspace-path check for `POST /agents`) stay exactly as they
  are for `send`.
- `electron/remote-control/audit.ts` — an entry kind for the full tier if the
  current shape assumes `send | interrupt | launch`.
- `electron/remote-control/listener-routes.ts` — `/me` returns `capability`
  **and keeps `canSend`** (derived) so `src/remote-client/main.ts` needs no
  change.

## Pairing UI and IPC

- `electron/ipc/remote-control.ts` — `remoteControl:pair(label, capability)`;
  validate against the three strings.
- `electron/preload.ts`, `src/electron.d.ts` — `pair(label, capability)`.
- `src/components/settings/RemoteControlPage.tsx` — replace the checkbox with
  a three-way choice (use the `ui/` radio or segmented component if one
  exists; check `src/components/ui/` first). Default `read`. Labels:
  *Watch* / *Reply* / *Everything*. The `full` option carries the blunt
  sentence: "This device can do anything the desktop app can, including
  removing workspaces." Keep the `send` warning copy.
- `src/components/settings/RemoteControlDialogs.tsx` — the tunnel-start
  dialog's "N of them can also type into a live shell" becomes counts per tier
  where non-zero.
- `src/store/remote-control-store.ts` — pass through; no state change.

## Tests

- `electron/remote-control/__tests__/allowlist.test.ts` — add
  `describe("the full tier")`: it is the entire route table, in order, with the
  real handler objects; and every existing exclusion test (`/projects`,
  `/issues`, `/agents/*`, any `DELETE`, pane and tab mutation) is asserted for
  **both** `read` and `send` explicitly, so nobody reads "full" as "send".
- `electron/remote-control/__tests__/` server tests — a `full` device reaches
  `DELETE`-family routes and lands an audit line without `confirmed`; a `send`
  device still needs `confirmed` and still cannot reach them.
- `devices.ts` test — migration of a `canSend` record.

## Files to touch
- `electron/remote-control/devices.ts` — tier type, migration, `pair`
- `electron/remote-control/allowlist.ts` — `allowedKeys`/`remoteRouteTable` by tier
- `electron/remote-control/server.ts` — table build, full-tier audit in `guardWrites`
- `electron/remote-control/audit.ts` — full-tier entry
- `electron/remote-control/listener-routes.ts` — `/me` shape
- `electron/ipc/remote-control.ts`, `electron/preload.ts`, `src/electron.d.ts` — `pair` signature
- `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx` — tier picker and copy
- `electron/remote-control/__tests__/allowlist.test.ts` and server/device tests
