---
title: SealedStore with atomic writes, surfaced failures and typed unavailability
status: done
priority: critical
assignee: opus
blocked_by: []
---

# SealedStore with atomic writes, surfaced failures and typed unavailability

Fixes review blockers B1–B3 and structural finding S6 in one place.

## Problems (verified)

- `electron/platform/sealed-file.ts` `writeSealed` does `fs.promises.writeFile(file, …)` in place: no temp file, no rename.
- `electron/app-lifecycle.ts` `before-quit` (~line 1050) does `void Promise.all([remoteDeviceStore.flush(), relayIdentityStore.flush()])` — nothing waits. Header comment of sealed-file.ts claims the app awaits it.
- `SealedWriter.write` catches and `console.warn`s every error; `flush()` never rejects. `RemoteDeviceStore.pair()` (`devices.ts` ~173) and `revoke()` (~290) report success when nothing was saved. `host-server/relay.ts` ~268 has a `.catch` on `flush()` that can never run.
- `secret-box.ts` `defaultExec` turns spawn failure/timeout into `{code: null}`; `systemdCredsBox.run` then throws the same generic Error as a wrong key. Stores (`relay/identity.ts` ~151, `devices.ts` ~127, `push.ts` ~256) catch everything and start over → new identity / empty devices / new VAPID key.
- `devices.ts`, `relay/identity.ts`, `push.ts` each re-implement: decrypt once in `init()`, a loaded/inited flag, an `available()` guard, queued writes. `push.ts` has its lazy load duplicated (~125-128 and ~217-220). `linear.ts` calls `writeSealed` directly. `identity.ts` imports `EncryptionUnavailableError` from `devices.ts`.
- `identity.init()` returns early without setting `inited` when the box is unavailable; later `ready()` throws "init() has not completed".

## Do

1. In `electron/lib/fs-atomic.ts`, add `writeFileAtomicAsync(file, data, { mode })` (temp file in same dir, write, fsync if the sync twin does, rename; chmod to mode). Mirror `writeFileAtomic`.
2. Add `electron/platform/sealed-store.ts` (or rework `sealed-file.ts`; delete `SealedWriter`):
   ```ts
   export class EncryptionUnavailableError extends Error {}   // moved from devices.ts
   export class SealedStore<T> {
     constructor(box: SecretBox, file: string, label: string, codec: { parse(text: string): T | null; serialize(v: T): string })
     async init(): Promise<T | null>   // ENOENT → null; corrupt/undecryptable/unparseable → null (logged); SecretBoxUnavailableError → rethrow
     write(value: T): void             // throws EncryptionUnavailableError if !box.available(); throws the stored first failure if a previous write failed; queues seal + writeFileAtomicAsync in order
     flush(): Promise<void>            // resolves when queue drains; rejects with first failure
   }
   ```
   `readSealed` returns `null` only for ENOENT.
3. In `secret-box.ts`, add `export class SecretBoxUnavailableError extends Error` thrown when a helper could not run (`code === null` from exec / spawn error / timeout), distinct from a decrypt failure. Same for libsecret path where the helper/dbus can't be reached.
4. Migrate `remote-control/devices.ts`, `remote-control/relay/identity.ts`, `remote-control/push.ts` to `SealedStore`. Delete their loaded/inited flags and bespoke load/persist. `push.ts` gets an `init()` like the others (remove the double lazy-load and the branch in `importKeys`); update the callers that construct/init PushManager (desktop `app-lifecycle.ts`, host `host-server/relay.ts`). On `SecretBoxUnavailableError` in `init()`, rethrow: the feature stays off, files are not overwritten. Fix the identity `inited` bug as part of this.
5. `pair()` and `revoke()` (and revokeAll / identity reset paths) that need durability: make them async-await `flush()` before acknowledging, or expose an awaited variant the handlers use. Check every caller (desktop `controller.ts`, `bridge/handlers/remote-control.ts`, host `relay.ts`, tests) and update. Remove the dead `.catch` in host relay.
6. `linear.ts`: use `SealedStore` too if it fits naturally; otherwise at least use the atomic write.
7. `before-quit` in `app-lifecycle.ts`: on first quit, `event.preventDefault()`, await the store flushes (with a bounded timeout, e.g. 5s), then `app.quit()` again; guard against re-entrancy with a flag. Keep the rest of the shutdown order.
8. SecretBox contract (`secret-box.ts`): reword `available()` doc to "can store (sealed, or knowingly plaintext)"; drop `"env"` from `SecretBackend` (nothing produces it); derive `HostBackend` as `Exclude<SecretBackend, "safeStorage">`. Update the stale header in `devices.ts` that says "refuse rather than write plaintext"/"follows linear.ts/safeStorage".
9. Plaintext upgrade in `pickHostSecretBox` (~271-280): when the persisted choice is `"plaintext"`, probe systemd-creds then libsecret; if one works, re-seal every sealed file in the server dir (read with plaintext box, write with new box via atomic write), then persist the new choice. Update `docs/remote-hosts.md` where it tells users to delete keys and re-pair to upgrade.
10. Tests: update `electron/platform/__tests__/secret-box.test.ts`, `remote-control/__tests__/devices.test.ts`, `push.test.ts`, `relay/__tests__/identity.test.ts`, `linear.test.ts`. Add tests: torn/garbage file → fresh state; ENOENT → null; SecretBoxUnavailableError → init rethrows and file untouched; failed write → flush rejects and next write throws; atomic write leaves old file intact if rename never happens; plaintext upgrade re-seals.

## Files to touch
- `electron/lib/fs-atomic.ts`
- `electron/platform/sealed-file.ts` (delete or reduce), `electron/platform/sealed-store.ts` (new), `electron/platform/secret-box.ts`
- `electron/remote-control/devices.ts`, `push.ts`, `relay/identity.ts`, `controller.ts` (await durable ops)
- `electron/linear.ts`
- `electron/app-lifecycle.ts` (before-quit, push init)
- `electron/host-server/relay.ts` (init/flush call sites only)
- `electron/bridge/handlers/remote-control.ts` (await durable ops if needed)
- tests listed above, `docs/remote-hosts.md`
