---
title: key-file SecretBox and one identity per instance
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# key-file SecretBox and one identity per instance

ADR-229 D5 and D6.

## What to build

- **`key-file` backend** in `electron/platform/secret-box.ts`.
  - Add `"key-file"` to `SecretBackend`.
  - `keyFileSecretBox(env)` reads a 32-byte key from `MANOR_SECRET_KEY`
    (base64), or from the file at `MANOR_SECRET_KEY_FILE` (raw 32 bytes, or
    base64 text; accept both, trimming whitespace). Anything else is a clear
    error.
  - `encrypt` is AES-256-GCM with a random 12-byte nonce and a versioned
    header (`MKF1` + nonce + tag + ciphertext). `decrypt` checks the header.
  - `pickHostSecretBox` tries it **first** whenever either variable is set.
  - ADR-226's persisted-choice rule applies:
    - a stored `key-file` choice with no key set throws
      `SecretBoxUnavailableError` with "Pairing keys were sealed with
      MANOR_SECRET_KEY, which is not set". It never falls back.
    - A plaintext host upgrades to `key-file` and re-seals, through the same
      path that upgrades to systemd-creds.
- **`secretKeyOnVolume`.** When `MANOR_SECRET_KEY_FILE` resolves (via
  realpath) under `$HOME/.manor`, `HostServerStatus` reports
  `secretKeyOnVolume: true`. The desktop's `HostPhoneAccess` shows the same
  style of warning as plaintext: "The key sealing pairing keys on \<host\>
  is stored on its own disk".
- **Instance identity** (`electron/host-server/`, next to where the relay
  identity is loaded).
  - `currentInstanceId()` returns:
    - `MANOR_INSTANCE_ID` if set;
    - else `/etc/machine-id` (trimmed) when `~/.manor/remote/supervisor.json`
      says `systemd`;
    - else `ioreg -rd1 -c IOPlatformExpertDevice`'s `IOPlatformUUID` when it
      says `launchd`;
    - else `null`.
  - Ticket 5 writes `supervisor.json`. Read it defensively; when it's absent,
    the value is null.
  - Store `instance.json` (`{instanceId}`) in the server data dir, written
    when the identity is first created.
  - On start, when both stored and current ids are non-null and differ:
    - delete every sealed store: relay identity, devices, push, VAPID and
      the Linear token. Use the existing stores' reset paths (`RelayRoom`
      reset, ADR-226), not raw unlinks, where they exist.
    - write the new `instance.json`;
    - log `cloned data dir: identity reset`;
    - set `identityReset: "cloned"` in the status until the next owner
      connect reads it.

    Projects, agents and layout are kept.
  - Stored null and current non-null: record the current id. Never reset in
    this case.
- The desktop's `HostPhoneAccess` shows a one-time notice for
  `identityReset: "cloned"`: "\<host\> was copied from another machine, so
  it got new pairing keys. Phones paired with this Mac re-link on their
  own."

## Tests

- `keyFileSecretBox`: a round trip; wrong key fails; bad header fails; env
  and file variants.
- `pickHostSecretBox`: order; persisted `key-file` without a key throws;
  plaintext upgrades.
- Instance check with fake env and fs: differing ids reset the sealed stores
  and keep `projects.json`; null to id records without a reset; equal ids do
  nothing.

## Files to touch
- `electron/platform/secret-box.ts`, `electron/platform/__tests__/*`
- `electron/host-server/server.ts` (or wherever identity/stores are built), new `electron/host-server/instance.ts`
- `electron/host-server/relay.ts` (`HostServerStatus` fields)
- `src/components/settings/HostPhoneAccess.tsx` (two notices)
