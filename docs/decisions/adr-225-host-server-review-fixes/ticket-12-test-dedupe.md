---
title: Split host-server tests with a shared harness and dedupe E2E helpers
status: todo
priority: low
assignee: sonnet
blocked_by: [11]
---

# Split host-server tests with a shared harness and dedupe E2E helpers

## Do

1. `electron/host-server/__tests__/host-server.test.ts` (~992 lines): split along its describe blocks into `boot-and-agents.test.ts`, `relay-room.test.ts` (host), `owner-channel.test.ts`. Put `HarnessTransport`, `serve()`, `phone()` in `__tests__/harness.ts`. Merge the two polling helpers (`eventually` ~182, `until` ~222) into one.
2. Replace the test's own `OwnerClient` (~102-180) with the real `HostServerClient` connecting to `server.sock` (its `open: () => Promise<Duplex>` accepts a net socket). If the client now expects a stream already past its hello (ticket 8), have the harness consume the hello with the shared `awaitHelloLine`.
3. E2E: extract `completePairingDialog(window, scope, label)` in `tests/e2e/helpers/settings.ts`; `pairDevice` and `pairHostPhone` call it after clicking their own trigger. Add `resetRemoteBox()` and `hostServerPid()` to `tests/e2e/helpers/remote-host.ts`; use them from both `host-server.spec.ts` and `remote-host.spec.ts` `beforeAll`, and fold `wipeRemote` into it where it's the same thing. `hostServerPid` shares the pid-file read with `stopHostServer`.
4. Do NOT run Playwright (it trips the agent watchdog). Typecheck the E2E files (`pnpm typecheck` covers them if included; otherwise `npx tsc --noEmit -p` on the e2e tsconfig).

## Files to touch
- `electron/host-server/__tests__/*`
- `tests/e2e/helpers/settings.ts`, `remote-host.ts`, `tests/e2e/host-server.spec.ts`, `tests/e2e/remote-host.spec.ts`

## Added from ticket 5

5. `two-readers.test.ts` builds the desktop reader via `createAgentPipeline` but still hand-writes the desktop's arguments. Extract a small `desktopAgentPipelineOptions(...)` (or similar) helper that `initApp` (`electron/app-lifecycle.ts`) and the test both call, so a change in how the desktop configures the pipeline is caught. Keep it Electron-free.

## Added from ticket 6

6. `electron/host-server/layout.ts` header still says "Ticket 6 adds the synthetic 'Started while away' tab…" — stale; fix the comment.
7. The shared harness should replace the `internals` callback usage in `electron/backend/__tests__/host-server-client.test.ts` where it simplifies things (keep `HostServerOptions.internals` only if tests still need it).
