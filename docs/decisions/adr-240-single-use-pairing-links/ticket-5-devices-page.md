---
title: Devices page - waiting and expired rows, New link, dialog copy
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Devices page: waiting and expired rows, New link, dialog copy

Implement ADR-240 D6. Read `index.md` in this folder and `.claude/rules/ui-components.md` (use `Button`, `Tooltip` from `src/components/ui/`).

- `src/components/settings/DeviceRow.tsx`: active rows unchanged. `device.pending` with `expiresAt > now`: hint "Waiting for the device to open the link · expires in N min" (N = ceil minutes, min 1) and a ghost **New link** button (`data-testid="remote-device-new-link"`). Expired: hint "Link expired" and **New link**. A `setTimeout` to `expiresAt` (and a minute tick for N, if cheap) re-renders. Trash tooltip "Remove this device" for pending, current text for active; `aria-label` stays `Revoke ${label}`. New prop `onNewLink`.
- `src/components/settings/DevicesPage.tsx` (:61, :155-163): `onNewLink` → store `reissue(id)` → `setPairing(result)` reopens `PairingResultDialog`; errors surface like `handlePair`'s.
- `src/components/settings/RemoteControlDialogs.tsx` (:295-330): description "This link works once and expires in N minutes. If it expires, choose New link on the device's row." with N from `result.expiresAt` (fallback 10; if `expiresAt` null, keep the old copy).
- `src/store/remote-control-store.ts` (:33, :102): `reissue(id)` calling `api.reissue`, refreshing status like `pair`.
- `src/components/settings/SettingsModal/SettingsModal.module.css` only if a new class is truly needed (prefer existing `fieldHint`).

## Files to touch
- The files above. If the repo's test setup supports it (see `src/components/settings/HostsPage/__tests__/ThisMacRow.test.ts`), add a small test for the row's text by state; otherwise the e2e (ticket 7) covers it.

Acceptance: `pnpm typecheck`, `pnpm lint`.
