---
title: Platform ports for secrets, notifications and app info
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Platform ports for secrets, notifications and app info

ADR-218 D6. Remove direct Electron imports from the modules the host server
reuses. On Electron, behaviour must stay exactly the same.

- New `electron/platform/secret-box.ts`: `interface SecretBox { available(): boolean; backend(): "safeStorage" | "systemd-creds" | "libsecret" | "plaintext" | "env"; encrypt(b: Buffer): Promise<Buffer>; decrypt(b: Buffer): Promise<Buffer> }`. It is async because the host backends shell out.
  - `electronSecretBox` wraps `safeStorage`; it lives in an Electron-only module.
  - `systemdCredsSecretBox`:
    - Detect it with `systemd-creds --version` (≥ 256) plus a round-trip probe of `systemd-creds --user encrypt` and `decrypt` at startup.
    - Pipe through stdin/stdout. Never put secrets in argv.
  - `libsecretSecretBox`:
    - Use `secret-tool store/lookup` when `DBUS_SESSION_BUS_ADDRESS` is set and a probe succeeds.
    - Keep only a random data key in the keyring; encrypt the files with it.
  - `plainFileSecretBox` is the identity function. Callers already write files 0600.
  - `pickHostSecretBox()` returns the first that works, in that order. The choice is persisted, so a backend that later disappears gives a clear error ("Pairing keys were encrypted with systemd-creds, which is no longer available") instead of silently writing plaintext.
- Existing callers must handle the now-async `encrypt` and `decrypt`.
- `RemoteDeviceStore` (`remote-control/devices.ts`), `PushManager` (`push.ts`), `RelayIdentityStore` (`relay/identity.ts`) and `linear.ts` take a `SecretBox` in their constructor or options instead of importing `safeStorage`.
  - Keep throwing `EncryptionUnavailableError` when `available()` is false.
- New `electron/platform/app-info.ts` (`version`, `isPackaged`, `logsDir`) and `notifier.ts` (`notify(opts)`; no-op implementation for headless).
- `app-lifecycle.ts` builds the Electron implementations and passes them in.
- Move the `wipe` helper out of `identity.ts` (or keep it pure) so `relay/connector.ts` has no transitive Electron import.
- Unit tests:
  - devices, push and identity round-trip through `plainFileSecretBox` in a temp dir.
  - `pickHostSecretBox` falls back correctly with fake probes. Skip the real `systemd-creds` probe in CI unless it is available.
  - A test that bundles `relay/connector.ts`, `devices.ts`, `push.ts` and `identity.ts` with esbuild and asserts no `electron` import, the same check as `scripts/build-host-tarball.mjs:58-66`.

## Files to touch
- `electron/platform/secret-box.ts`, `app-info.ts`, `notifier.ts` (new)
- `electron/remote-control/devices.ts`, `push.ts`, `relay/identity.ts`, `relay/connector.ts`
- `electron/linear.ts`
- `electron/app-lifecycle.ts`: construct the Electron implementations and inject them
