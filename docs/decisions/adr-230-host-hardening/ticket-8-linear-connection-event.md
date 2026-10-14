---
title: Linear publishes connectionChanged and the phone follows it
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [6]
---

# Linear publishes connectionChanged and the phone follows it

ADR-230 D8 (gap R4).

## What to build

- **Manager.** `LinearManager` (`electron/linear.ts:95-111`) takes an
  `onChange?(connected: boolean)` option, called after `saveToken` and
  `clearToken`.
- **Connect handler.** `linearConnect` in
  `electron/bridge/handlers/integrations.ts:199-216` saves the token, then
  validates it, then clears it on failure. Change it to validate first and
  save only on success, so a failed connect emits nothing. If the API
  can't validate without a saved token, accept the connect-then-disconnect
  pair and note it.
- **Server wiring.** `createManorServer` (`electron/server/create-manor-server.ts:380`)
  wires `onChange` to `bus.publish("linear", "connectionChanged", connected)`.
  That covers both the desktop and the host server, including the host's
  `hostServerSetLinearToken` path
  (`electron/host-server/handlers.ts:406-415`). Check that it goes through
  the manager.
- **Events.** `electron/bridge/events.ts` gains
  `linear: { connectionChanged: [connected: boolean] }` in `EventMap`, and
  `"linear.onConnectionChanged"` in `SUBSCRIPTIONS`. Add the event to the
  host server's allowed events if there is such a list.
- **Phone.** In `src/bridge/linear-servers.ts`, subscribe to
  `linear.onConnectionChanged` on each entry's bridge:
  - subscribe as entries join and unsubscribe as they leave, as `openFan`
    does in the router;
  - set that entry's `connected` and call `changed()`;
  - keep the hello and `pairingChanged` refresh for older servers;
  - fix the `pairingChanged` subscription so it follows a change of home
    (today it binds to the home bridge at creation, :210-217).
- **Desktop settings.** `LinearIntegrationSection.tsx`,
  `LinearProjectSection.tsx` and `HostPhoneAccess.tsx` refresh on the
  event, instead of only on mount.

## Tests (each must fail on the base commit)

- `src/bridge/__tests__/linear-servers.test.ts`, with `subscribe` capturing
  the listener: emitting `connectionChanged(true)` on a non-home entry flips
  its `connected` and notifies subscribers.
- `electron/linear.test.ts`: `onChange` fires on save and on clear.
- `electron/host-server/__tests__/linear-on-host.test.ts`, with the harness
  and `client.subscribe` as in `adoption.test.ts:50`: setting the host's
  token publishes `linear.connectionChanged`.

## Files to touch
- `electron/linear.ts`, `electron/bridge/handlers/integrations.ts`
- `electron/server/create-manor-server.ts`, `electron/bridge/events.ts`
- `src/bridge/linear-servers.ts`
- `src/components/settings/**/LinearIntegrationSection.tsx`, `LinearProjectSection.tsx`, `HostPhoneAccess.tsx`
- Tests named above.
