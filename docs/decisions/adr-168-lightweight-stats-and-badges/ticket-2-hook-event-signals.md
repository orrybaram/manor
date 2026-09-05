---
title: Hook-event signals: prompts, tool calls, unblock latency, concurrency
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Hook-event signals: prompts, tool calls, unblock latency, concurrency

Wire the hook relay into `StatsStore` through a pure mapping module (ADR-168 §2, first table row).

## Required behavior

`electron/stats-signals.ts` — add:

```ts
export type StatDelta =
  | { counter: StatCounter; n: number }
  | { gauge: StatGauge; value: number };

export interface SignalTrackerState { blockedAt: Map<string /* sessionId */, number /* mono ms */> }
export function createSignalTracker(): SignalTrackerState;

export function deltasForHookEvent(
  event: AgentHookEvent,
  effects: readonly Effect[],
  tracker: SignalTrackerState,
  ctx: { monoNow: number; activeAgentCount: number },
): StatDelta[];
```

Mapping (mutates `tracker` only):

- `UserPromptSubmit` → `prompts +1`. If `tracker.blockedAt` has `event.sessionId`: `unblocks +1`, `unblockMsTotal += monoNow - blockedAt`, `fastUnblocks +1` when the delta is under 10 000 ms; delete the entry.
- `PreToolUse` → `toolCalls +1`.
- `SubagentStart` → `subagents +1`.
- `Stop` → `agentsResponded +1`.
- `PermissionRequest` / `Notification` (both carry `status: "requires_input"`) → `blocks +1` and set `blockedAt` if not already set for that session (do not reset an existing block).
- Any event whose `effects` contain a `CreateAgent` effect → `agentSessions +1` and `{ gauge: "maxConcurrentAgents", value: ctx.activeAgentCount }`.
- `SessionEnd`, or any effects containing `DeleteSessionState` for the session → delete the `blockedAt` entry. No delta.
- `sessionId === null` events still count `prompts`/`toolCalls` etc. but never touch `blockedAt`.

`electron/hook-relay.ts`:

- Add optional dep `onHookEvent?: (event: AgentHookEvent, effects: readonly Effect[]) => void` to `HookRelayDeps`. Call it inside `relay()` after `applyEffects` ran, wrapped in try/catch that logs and swallows. Must not change any existing effect ordering; existing tests must stay green.

`electron/stats-store.ts`:

- Add `observeHookEvent(event, effects, activeAgentCount: number): void` that owns a `SignalTrackerState`, calls `deltasForHookEvent` with `monoNow = defaultMonoClock()` (import from hook-relay or duplicate the one-liner to avoid a cycle; prefer a tiny `electron/mono-clock.ts` if a cycle appears), and applies the deltas via `record`/`recordMax`. Batch: schedule one save/onChange per call, not per delta.

`electron/app-lifecycle.ts`:

- Construct `const statsStore = new StatsStore(undefined, { isEnabled: () => preferencesManager.get("statsEnabled") ?? true })` next to `notificationStore` (the preference is added in ticket 5; until then read it defensively via `getAll()` and default true).
- Pass `onHookEvent: (event, effects) => statsStore.observeHookEvent(event, effects, agentManager.getActiveAgents().length)` to `createHookRelay`.
- Call `statsStore.flushNow()` wherever `notificationStore.flushNow()` is called on quit.
- Add `statsStore` to the `IpcDeps` object literal; add the field to `electron/ipc/types.ts` (`/** ADR-168 usage stats. */ statsStore: StatsStore;`). Update any test fixture that constructs a full `IpcDeps`.

## Tests

`electron/__tests__/stats-signals.test.ts`: one case per bullet in the mapping, including unblock latency arithmetic, the fast threshold at exactly 10 000 ms (not fast), block not reset on repeated `Notification`, `SessionEnd` clearing, null-session safety.

`electron/__tests__/hook-relay-*.test.ts`: add one test that `onHookEvent` is invoked with the same effects the applier received and that a throwing `onHookEvent` does not break the relay.

## Files to touch
- `electron/stats-signals.ts` — add delta mapping + tracker
- `electron/stats-store.ts` — add `observeHookEvent`
- `electron/hook-relay.ts` — `onHookEvent` dep
- `electron/app-lifecycle.ts` — construct store, wire dep, flush on quit
- `electron/ipc/types.ts` — `statsStore` field
- `electron/__tests__/stats-signals.test.ts` — extend
- `electron/__tests__/relay-subagent-tracking.test.ts` (or a new `hook-relay-on-event.test.ts`) — relay tap test
