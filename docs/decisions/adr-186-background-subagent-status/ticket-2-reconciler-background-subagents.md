---
title: Reconciler keeps pane working while background subagents run
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# Reconciler keeps pane working while background subagents run

Implement ADR-186 §2–§5 in `electron/agent-status/reconciler.ts` (read the
ADR `index.md` in this folder in full first — it has the captured hook
sequences and exact rules).

## Summary of rules
1. Subagent key: `agent:<agentId>`, else `tool:<toolUseId>`, else
   `__fallback_N`. SubagentStop removes the key (or one entry when no id) and
   adds it to new state `finishedSubagents: ReadonlySet<string>`
   (`types.ts`, `initialPaneState`, `withoutRoot`, SessionStart replacement,
   StopFailure, and `stateFromSavedAgent` via initial state).
2. A root-session hook with `agentId !== null` is a subagent hook, handled
   before H1 and before the root rules:
   - always updates `lastHookAt`; never changes `phase` except the reopen
     case below;
   - phase `active` / `pendingStop`: active statuses show on the pane and
     persist (`PersistAgentStatus` active / `CreateAgent`) exactly as a root
     active hook does, phase untouched;
   - phase `responded` / `stalled` / `none`: `SubagentStart` for a key not in
     `finishedSubagents`, or an active hook whose key is in
     `activeSubagents`, reopens: phase `pendingStop`, `pendingStopAt = nowMs`,
     status from the event (`working` for SubagentStart), persist active.
     Anything else is dropped as late (reason string mentions it);
   - non-active statuses other than SubagentStop are ignored (never end the
     root turn).
   Root hooks (no agentId) keep H1 exactly as today.
3. T1 in `reconcileTurnTick`: if `activeSubagents.size > 0` and every key
   starts with `agent:`, threshold is new exported
   `STALE_SUBAGENT_MS = 15 * 60_000`; otherwise `STALE_STOP_MS`.
4. Update the rule table in the file's header comment (H1, H5, H7, T1) and the
   `activeSubagents` doc comment in `types.ts`.

## Tests (`electron/agent-status/__tests__/reconciler.test.ts`)
Follow existing helpers in that file. Add the cases listed in ADR-186 §5:
background flow with 20s gap stays working and ends with one `responded`
persist; T1 long vs short threshold; Stop-before-SubagentStart race reopens;
late hook from finished subagent dropped; subagent PreToolUse keeps
`pendingStop`; root PreToolUse after Stop still dropped. Existing ADR-130 /
ADR-139 tests must keep passing (update only if they assert the old
fallback-key string format).

Run `pnpm vitest run electron/agent-status electron/__tests__/agent-hooks.test.ts`
and the project typecheck (`pnpm tsc -p tsconfig.electron.json --noEmit` or
whatever `package.json` defines).

## Files to touch
- `electron/agent-status/reconciler.ts`
- `electron/agent-status/types.ts`
- `electron/agent-status/__tests__/reconciler.test.ts`
- `electron/agent-status/__tests__/driver.test.ts` / `restore.test.ts` only if they build `PaneAgentState` literals
