---
title: HostServerSync owns push endpoints; trim github PR cache and manifest inputs
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [8]
---

# HostServerSync owns push endpoints; trim github PR cache and manifest inputs

## Problems (verified by review)

- `HostPushEndpoints` cache written from five places: `app-lifecycle.ts` ~504 (refresh on `"connected"`, forget on `"unsupported"`), `onVapidKeysChanged` (`app-lifecycle.ts` ~207, called from `host-server-sync.ts` ~253), `bridge/handlers/hosts.ts` ~116 `pairingChanged`, and the read handler `hostsServerStatus` (~134) as a side effect. On connect the `"connected"` listener's `status()` races `sendAll`'s `setVapidKeys`; commit 605f1937 papered over it with a second refresh.
- `electron/github.ts` (1195 lines): `settledPrs` (~209) is a subset of `lastSeenPrs` (~218), never pruned; `rememberPr` (~282); `prSummary` (~939) duplicates the fingerprint check in `host-server-sync.ts` ~133 and leaks manifest knowledge ("What of a PR the host server manifest carries"); `{prs, reached}` change to `fetchPrsFromGitHub`.
- `projects/project-manager.ts` ~280 `manifestRecords` strips `hostPaths`, `host-server-sync.ts` ~86 strips again; it claims `PersistedProject[]` but builds a `ManifestProject` with `hostId` rewritten elsewhere.
- `projects/project-info.ts` ~116 `LastKnownWorkspaces.latest` is a copy of `recall` minus the away check.

## Do

1. `HostServerSync` owns the `HostPushEndpoints` cache. In `sendAll(hostId)`: `await pushVapidKeys(); await endpoints.refresh(hostId)` in order, with manifest + layout sent in parallel alongside. Forget on unsupported/remove. Expose `hostServerSync.pairingChanged(hostId)` for the mutating hosts handlers (pair/revoke/reset) to call. `hostsServerStatus` becomes a pure read. Delete the app-lifecycle listeners and `onVapidKeysChanged` refresh (keep the VAPID push itself, routed through sendAll/the sync). Delete the redundant second refresh from 605f1937.
2. `github.ts`: drop `settledPrs`; in `lookUpPrs` use `const seen = this.lastSeenPrs.get(k); if (seen?.pr && seen.pr.state !== "open") result.set(branch, seen.pr)`. Drop `prSummary`; fire the listener on every reached lookup (sync debounce + fingerprint dedupe already suppress no-op sends). Prune `lastSeenPrs` if a natural point exists. Net file size must go down. Update `github.test.ts`.
3. `manifestRecords` returns `ManifestProject[]` with `hostId: LOCAL_HOST_ID` set there; delete the re-strip loop in `buildHostManifest`.
4. `recall(p)` → `this.isHostAway(p.hostId) ? this.latest(p) : undefined`.

(The dedicated `hosts.pairingChanged` renderer event is ticket 11; here just route the cache refresh.)

## Files to touch
- `electron/backend/host-server-sync.ts`, `electron/app-lifecycle.ts`, `electron/remote-control/host-push-endpoints.ts`
- `electron/bridge/handlers/hosts.ts`, `__tests__/hosts.test.ts`
- `electron/github.ts`, `electron/github.test.ts`
- `electron/projects/project-manager.ts`, `electron/projects/project-info.ts`

## Added from ticket 8

5. `electron/backend/host-server-client.ts`: the `Channel` interface now wraps a single `stream` field; collapse it to `private stream: Duplex | null`.
