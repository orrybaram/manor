---
title: Phone holds several pairings and switches between hosts
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Phone holds several pairings and switches between hosts

ADR-218 D7.

- Web app (`src/bridge/install-web.ts` and the pairing storage):
  - Store pairings keyed by room id, with a display name: the host server sends `hostName` in its hello response.
  - A new pairing link adds to the stored pairings; it does not replace them.
- With more than one pairing, the phone top bar (`src/components/phone/`) shows a host switcher. Switching tears down the bridge and reinstalls it against the other room. This is a full reload of the app state, which is acceptable for slice 1.
- `unavailable:host` namespaces and refused mutations show the stated empty states. "Launch agent" and "New workspace" say "Not yet available from the phone for remote hosts".
- Each pairing has its own push subscription (`subscribePush` per connection).

## Files to touch
- `src/bridge/install-web.ts`, `src/bridge/transports/relay-pipe.ts` (only if pairing storage lives there)
- `src/components/phone/*`
