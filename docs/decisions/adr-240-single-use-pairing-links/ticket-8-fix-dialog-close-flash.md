---
title: Fix - pairing dialog flashes stale copy while closing
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Fix: pairing dialog flashes stale copy while closing

Found in evidence capture. `DevicesPage` closes `PairingResultDialog` with `setPairing(null)`; the dialog's close animation then renders with `result === null`, so for its exit frames it reads "Scan with " (no name) and `PairingExpiryCopy` falls back to the pre-ADR copy "This code is shown once. If you lose it, remove the device and add it again."

Fix in `PairingResultDialog`: keep rendering the last non-null `result` while the dialog closes (e.g. hold the last shown result in state updated whenever `result` is non-null, and render from that; `open` still follows `result !== null`). Do it without reading refs during render and without setState-in-effect lint violations (the repo's eslint has `react-hooks/set-state-in-effect` and purity rules; the "store previous props in state during render" pattern is acceptable if lint allows it). Add a unit test if the existing test setup allows; otherwise describe the manual check.

## Files to touch
- `src/components/settings/RemoteControlDialogs.tsx`
