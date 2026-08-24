---
title: Per-device token store with safeStorage
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Per-device token store with safeStorage

The remote surface authenticates with a per-device bearer token. Build the store and the
verification primitive before anything listens.

`electron/remote-control/devices.ts`:

```ts
interface RemoteDevice {
  id: string; // random id, safe to log
  label: string; // user-supplied, e.g. "Orry's phone"
  tokenHash: string; // sha256 hex of the raw token
  canSend: boolean; // write capability, default false
  createdAt: number;
  lastSeenAt: number | null;
}

class RemoteDeviceStore {
  pair(
    label: string,
    canSend: boolean,
  ): { device: RemoteDevice; rawToken: string };
  verify(rawToken: string): RemoteDevice | null;
  revoke(id: string): void;
  list(): RemoteDevice[]; // never includes tokenHash
}
```

Requirements, all load-bearing:

- Raw token is `crypto.randomBytes(32).toString("base64url")`, returned **once** from
  `pair()` and never persisted in any form other than its SHA-256.
- `verify()` hashes the presented token, then compares against each stored hash with
  `crypto.timingSafeEqual` over equal-length Buffers. Compare hashes, not raw tokens, so
  token length is not an oracle. Return `null` on any parse failure without a distinct
  error path that could be timed.
- Persist through `safeStorage.encryptString` / `decryptString`, following
  `electron/linear.ts:57-69` exactly. Add `remoteDevicesFile()` to `electron/paths.ts`
  under `manorDataDir()` (app-internal state — read the module header's rule and follow
  it), mode 0600.
- `revoke()` takes effect immediately: the lookup set is the live store, never a cached copy.
- Handle `safeStorage.isEncryptionAvailable()` returning false — refuse to store tokens
  rather than falling back to plaintext, and surface that as a clear error.

Add a rate limiter in `electron/remote-control/rate-limit.ts`: per-source-address failure
counter with exponential backoff (start 1s, double, cap 60s), swept on a timer so it
cannot grow unbounded.

Tests: pairing returns a token that verifies; a mutated token does not; revocation is
immediate; a wrong-length token is rejected without throwing; persistence round-trips;
encryption-unavailable refuses rather than degrading.

## Files to touch

- `electron/remote-control/devices.ts` — new.
- `electron/remote-control/rate-limit.ts` — new.
- `electron/paths.ts` — `remoteDevicesFile()`.
- `electron/remote-control/__tests__/devices.test.ts` — new.
