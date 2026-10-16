---
title: "Hosts page: Encrypt them button, per-case copy, after-fix note"
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Hosts page: Encrypt them button, per-case copy, after-fix note

Implements ADR-236 D6. Read the ADR first and follow `.claude/rules/ui-components.md`: use `<Button>` and `<Link>`.

1. **`src/store/host-store.ts`:** add `encryptKeys(hostId)`, which calls `window.electronAPI.hosts.encryptKeys(hostId)` (or the store's existing API accessor), then `refreshServer(hostId)`.
2. **`host-settings-text.ts`:** add the copy as plain functions:
   - `plaintextFixText(hostName, keyFile)`
   - `keyInHomeText(hostName, keyFile)`
   - the recipe and container hints
   - the reworded on-volume text: "…is kept inside ~/.manor on <host>, beside what it protects."

   Wording is in ADR D6. Default keyFile is `~/.config/manor/secret.key`.
3. **`HostRow.tsx`:**
   - `HostDeviceAccess` computes `fix: "button" | "recipe" | "container" | "none"`. It is `button` only when the host is not read-only, `host.status === "connected"`, `view.state === "connected"`, `host.providerKind !== "recipe"`, and `status.supervisor?.kind !== "container"`.
   - Pass `fix`, `busy` and `run` (from `useHostAction`) into `KeyWarnings`.
   - **Plaintext:** keep the `host-plaintext-keys` warning; under it, render the per-case hint and, for `button`, `<Button size="sm" data-testid="host-encrypt-keys" disabled={busy}>Encrypt them</Button>`, which calls `run(() => encryptKeys(hostId))`.
   - **`secretBackend === "key-file"` and `secretKeyPlace === "home"`:** render a muted `fieldHint` with `data-testid="host-key-in-home"`, and nothing in the header `keyWarnings()`.
   - **`secretKeyPlace === "data-dir"`, or an absent place with `secretKeyOnVolume` (an older server):** the existing `host-key-on-volume` warning with the new wording.

## Files to touch
- `src/store/host-store.ts`: `encryptKeys`
- `src/components/settings/HostsPage/HostRow.tsx`: KeyWarnings variants, button, fix discriminator
- `src/components/settings/HostsPage/host-settings-text.ts`: copy functions
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts`:
  - mock `encryptKeys`
  - the button is shown only for a connected ssh host, and hidden for recipe, container, away and read-only
  - a click calls `encryptKeys` with the host id
  - `host-key-in-home` for key-file + home
  - the on-volume warning for `data-dir`
  - the older-server fallback via `secretKeyOnVolume`
  - text helpers
