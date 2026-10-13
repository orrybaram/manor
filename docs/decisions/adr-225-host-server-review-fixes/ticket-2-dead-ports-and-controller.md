---
title: Delete dead platform ports and simplify controller push-endpoint wiring
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Delete dead platform ports and simplify controller push-endpoint wiring

## Do

1. **Notifier:** `electron/platform/notifier.ts` (`Notifier`, `noopNotifier`) has zero importers; `knip.json` lists it under `ignore` only to silence that. Delete the file and the ignore entry.
2. **AppInfo:** `electron/platform/app-info.ts` has three fields; only `.version` is read (`app-lifecycle.ts` ~537,555; `host-server/server.ts` ~158,227,294,303). `isPackaged` is hard-coded `true` in `host-server/serve.ts` ~105-109, `logsDir` is never read. Replace with an `appVersion: string` option/param everywhere and delete the file.
3. **Controller push dedupe** (`electron/remote-control/controller.ts` ~123-124, 187-203; `app-lifecycle.ts` ~495, 557): `hostPushEndpoints` is a nullable field set later via `setHostPushEndpoints`, though `HostPushEndpoints` is built before the controller. Pass `hostPushEndpoints: (hostId: string) => ReadonlySet<string>` in the constructor options (default `() => EMPTY_SET`). Delete the setter and the null state. Drop the `agent.hostId !== "local"` check (redundant — `HostPushEndpoints.get` returns empty for uncached hosts; and it should have been `LOCAL_HOST_ID`).
   ```ts
   pushAgentTransition(this.push, agent, previousStatus, status, {
     skipEndpoints: agent.hostId ? this.hostPushEndpoints(agent.hostId) : undefined,
   });
   ```
4. **Controller `encryptionAvailable` param** (~129): remove it if the same fact is reachable through the device store / push (their SecretBox). If removing it would require threading the box anyway, take the `SecretBox` instead of a bare boolean function.
5. Update `controller.test.ts` and any other tests.

## Files to touch
- `electron/platform/notifier.ts` (delete), `electron/platform/app-info.ts` (delete), `knip.json`
- `electron/app-lifecycle.ts`, `electron/host-server/server.ts`, `electron/host-server/serve.ts`, `electron/host-server/index.ts` (exports)
- `electron/remote-control/controller.ts`, `electron/remote-control/__tests__/controller.test.ts`
- `electron/platform/__tests__/electron-free.test.ts` if it lists the deleted files
