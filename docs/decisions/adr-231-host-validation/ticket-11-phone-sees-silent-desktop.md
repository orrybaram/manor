---
title: The phone sees a silent server as away
status: todo
priority: high
assignee: opus
blocked_by: [5, 8]
---

# The phone sees a silent server as away

ADR-231 D8. Ticket 5's lid-closed E2E found this; read its "Found" section
first.

## The bug

- A phone paired with a desktop never reads the desktop as away while the
  desktop is frozen (asleep).
- For about 90 s the relay answers the phone's `HEARTBEAT_PING` itself, so
  the line looks alive. Meanwhile merged reads (`router.ts` `merged()`) hang
  on the silent server.
- After the relay reaps the desktop (`STALE_AFTER_MS`, 90 s), the phone's
  sidebar still doesn't dim the desktop's own projects. `isHostOffline`
  (`src/lib/host-status.ts:282-298`) only dims a host that some host list
  reports, or one with no direct bridge whose every listing server is
  unreachable. The desktop's own room is neither.

## What to build

### 1. End-to-end liveness in the bridge transport

`src/bridge/transports/ws.ts`, `WsTransport`:
- **Track the last inbound bridge frame** from the far server: a result,
  an event or a hello.
- **When it goes quiet.** While the transport is `ready`, once nothing has
  arrived for `SERVER_SILENCE_MS` (10 s), send one bridge request the far
  server must answer.
  - Use a dedicated no-op, `bridge.ping`, answered by `BridgeServer`
    itself before routing. It takes no handler and is allowed for every
    caller class.
  - First check what an *older* server (one without `bridge.ping`) does
    with an unknown method. If it answers with an error frame, that
    answer counts as alive too, so old desktops and hosts still work.
  - If an older server drops unknown methods silently, use an existing
    cheap method every server answers instead, and say which one in the
    commit.
- **If no frame of any kind** arrives within `SERVER_SILENCE_TIMEOUT_MS`
  (5 s) of the ping, treat the line as dead, exactly as a failed `probe()`
  already does: report it through `onClose` as unreachable, close the
  socket and `redialNow()`.
  - The redial's hello then decides. A frozen desktop gives no hello, and
    the existing first-hello deadline and backoff take it from there.
- **Worst case:** a silent server reads unreachable about 15 s after it
  went quiet.
- **Relay budget.** Pings go through the relay, so they count against the
  room's daily byte budget (ADR-206 D1).
  - Ping only after silence. A busy line never pings.
  - Check the budget's size, and state the idle cost per phone per day in
    the commit (one ping and one answer per 10 s of silence).
  - If the cost is more than 1% of the budget, raise `SERVER_SILENCE_MS`
    and say so.
- **`probe()` (ADR-220 D4)** keeps its relay-level check, and also counts
  only a bridge answer as "alive", so a foreground check catches a silent
  desktop too. Keep `PROBE_TIMEOUT_MS`.
- **Desktop windows.** Desktop windows' host pipes (ADR-228 D4) use the
  same transport. Leave the liveness check on for them too, unless it
  breaks a test. A host server that is alive answers in milliseconds over
  ssh.

### 2. The away rule

In `src/lib/host-status.ts` `isHostOffline`:
- A host whose **direct** source is `unreachable` is away **unless** a
  server that lists it (`via`) is `connected`. That is ADR-228 D3's source
  2, which still serves it.
- This covers the desktop's own room on the phone. On the desktop nothing
  changes, because the home server is never unreachable.
- Check `HostOfflineBanner`, the sidebar dimming, `groupHostState` and the
  Hosts sheet. They all read through this helper or the same reachability,
  so they should agree with no extra work. Don't add a second rule
  elsewhere.

### 3. Merged reads stop waiting on a dead server

Once part 1 marks the server unreachable, `merged()` skips it, as it skips
any unreachable server. Confirm the hang ends when the server is marked.
If a call already in flight to the silent server is still awaited, fail it
on the transport's close, as other in-flight calls are.

## Tests (each must fail on the base commit)

- **`ws.test.ts`** (fake timers, a fake pipe whose far end goes silent but
  whose `probe()` still says alive, as the relay does):
  - no ping while traffic flows;
  - a ping after 10 s of silence;
  - unreachable and a redial 5 s after an unanswered ping;
  - an answer, or an error frame for an unknown method, keeps it ready.
- **The server answers `bridge.ping`** (bridge server tests) for each
  caller class.
- **`host-status` tests:**
  - a direct source unreachable with no `via`: away;
  - unreachable direct with `via` connected: not away;
  - direct connected: not away.
- **E2E.** In `tests/e2e/lid-closed.spec.ts`, delete the `relayTest.fail`
  branch. The "desktop reads as away within 30 s" check must now pass
  outright. Run that spec 3 times on the private sshd and once in
  `--docker` (`sg docker -c …`). Also run `tests/e2e/phone-drop-grace.spec.ts`
  (5 times), `phone-linked-hosts.spec.ts` and `phone-all-pairings.spec.ts`
  through the harness (`--grep` or `--serve`), to check nothing regressed.

## Environment notes

- Web code changes need `pnpm build:web:relay`. Desktop or server changes
  need `pnpm build && node scripts/build-host-tarball.mjs`.
- No other agent is running when this ticket starts.

## Files to touch
- `src/bridge/transports/ws.ts`: silence tracking, the ping, `probe()`.
- `electron/bridge/server.ts` (or wherever frames are dispatched): `bridge.ping`.
- `electron/bridge/types.ts` / method tables / `routes.ts`: only if a new method must be declared (it is answered before routing, so ideally not).
- `src/lib/host-status.ts`: the away rule.
- Tests: `src/bridge/transports/__tests__/ws.test.ts`, the bridge server tests, the host-status tests.
- `tests/e2e/lid-closed.spec.ts`: drop the expected-failure branch.
