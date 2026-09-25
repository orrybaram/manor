---
title: HostProvider seam and SshHostProvider
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# HostProvider seam and SshHostProvider

**Prerequisite:** ADR-160 tickets 5 (SshTransport) and 9 (BackendRegistry) are done.

Put a provider between `HostSpec` and `HostTransport` so managed sandboxes can be added
later without touching the registry.

1. Create `electron/backend/providers/types.ts` with the `HostProvider` interface from
   ADR-178 §1 (`kind`, `capabilities`, `ensureUp`, `status`, `transport`, `forwardPort`,
   optional `previewUrl`, optional `setBusy`) and `HostStatus`.
2. Create `electron/backend/providers/ssh-provider.ts`: `SshHostProvider` wraps
   ADR-160's `SshTransport`. `ensureUp` is a no-op. `status` maps transport state.
   `forwardPort(remotePort)` picks a free local port and runs
   `ssh -S <controlPath> -O forward -L <local>:127.0.0.1:<remote> <target>` on the
   existing ControlMaster; `dispose` runs `-O cancel` with the same spec.
   Capabilities: `{ autoSleep: false, persistsMemory: false, previewUrls: false }`.
3. Create `electron/backend/providers/index.ts`: `createProvider(spec: HostSpec)`.
4. In `electron/backend/registry.ts`: build hosts via `createProvider`, call
   `provider.ensureUp()` before connecting the transport, expose `provider(hostId)`.
5. Keep-awake: add a registry method `updateBusy(hostId, busy)` that calls
   `provider.setBusy?.(busy)` only on change. Wire it from wherever agent status per
   pane is aggregated in main (hook relay effects / agent detector bridge): busy = any
   pane on that host has an agent in an active status. No-op for ssh, but the wiring
   must exist and be unit-tested with a fake provider.

Tests: fake provider verifying `ensureUp` ordering and busy transitions; ssh-provider
argument construction for forward/cancel.

## Files to touch
- `electron/backend/providers/types.ts` — new.
- `electron/backend/providers/ssh-provider.ts` — new.
- `electron/backend/providers/index.ts` — new.
- `electron/backend/registry.ts` — provider construction, `ensureUp`, `updateBusy`.
- `electron/hook-relay-effects.ts` (or the agent-status aggregation point) — busy wiring.
