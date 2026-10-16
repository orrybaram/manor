---
title: Desktop method hosts.encryptKeys
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Desktop method hosts.encryptKeys

Implements ADR-236 D7. Read the ADR first.

1. **`electron/backend/host-secrets.ts`** (new): `runHostSecrets(transport, "encrypt" | "status")`.
   - Mirror `electron/backend/host-supervisor.ts`: run `"$HOME/.manor/bin/manor-host" secrets <verb> --json` through `transport.exec` with a 60 s timeout, then parse the last JSON line.
   - `{error}` throws an Error carrying that message. Success returns the `secrets` facts.
2. **`hostsEncryptKeys(hostId)` in `electron/bridge/handlers/hosts.ts`**, shaped like `hostsSetSupervised`:
   - `assertKnownHost`; a provider without `exec` is refused with a clear error.
   - Call `runHostSecrets(..., "encrypt")`.
   - Wait up to about 15 s for `backendRegistry.hostServer(hostId)` to report `connected` again; resolve anyway on timeout.
   - Call `publishRendererBroadcast("hosts", "pairingChanged", hostId)` and return the facts.
   - Register it in the handler table with `{ localOnly: true, mutating: true, route: LOCAL_ROUTE }`.
3. Add `"hosts.encryptKeys": "home"` to `electron/bridge/routes.ts`, add it to `LOCAL_ONLY_METHODS` in `electron/bridge/local-only.ts`, and add it to `HostRefusedMethod` in `src/bridge/unavailable.ts`. The surface check test needs all three.

## Files to touch
- `electron/backend/host-secrets.ts`: new
- `electron/bridge/handlers/hosts.ts`: handler and table entry
- `electron/bridge/routes.ts`: route
- `electron/bridge/local-only.ts`: local-only list
- `src/bridge/unavailable.ts`: `HostRefusedMethod`
- `electron/bridge/handlers/__tests__/hosts.test.ts`: the exec command line, parsed facts, error passthrough, unknown host, transport without exec, pairingChanged broadcast
