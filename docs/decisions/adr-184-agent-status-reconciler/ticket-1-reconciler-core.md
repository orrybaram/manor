---
title: Pure Status reconciler with a full transition table
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# Pure Status reconciler with a full transition table

Read `index.md` and `/CONTEXT.md` first. This ticket builds the reconciler **unwired**.
Nothing in production calls it yet.

1. Create `electron/agent-status/types.ts` with:
   - `StatusSignal`: the sealed union `hook` | `paneFacts` | `tick` | `user`;
   - `PaneFacts`: `{ foreground: { name, kind | null } | null; title: string | null; outputHint: { hint: "thinking" | "working" | "requires_input" | "idle"; at: number } | null }`;
   - `PaneAgentState`: the per-pane state, holding the root session, children, phase,
     `hookDriven`, `activeSubagents`, the last hook time, the last facts and the current
     status;
   - `ReconcileResult`: `{ state, status, reason, effects }`;
   - `Effect`: extend ADR-139's effect union. Add `PublishPaneStatus`,
     `PersistAgentStatus` (lifecycle plus last status, as one named transition) and
     `MarkSeen` if needed. Drop `RelayAgentHook`.
   - `AgentStatus` without `"complete"`, local to this module for now. Ticket 5 unifies it.
2. Create `electron/agent-status/reconciler.ts` with the pure function `reconcile(state,
   signal, ctx)`. `ctx` holds `{ nowMs, existingAgent }`. It has no IO, no timers and no
   mutation of its inputs. Implement every rule in ADR-184 §1:
   - **Port ADR-139's rows from `electron/hook-relay-transition.ts`:**
     - the late-active guard;
     - SessionStart root replacement;
     - the no-sessionId case;
     - child detection;
     - SubagentStart/SubagentStop bookkeeping;
     - active event → create or update the agent;
     - Stop held while subagents are active, otherwise responded;
     - SessionEnd draining a held Stop and then completing;
     - StopFailure → error.
   - **Child activity:** a child session's active hook can publish thinking or working
     while the root's turn is in progress. Child terminal events never end the turn.
   - **Hook-driven:** a pane becomes hook-driven on the root session's first hook and stays
     that way until SessionEnd or until it goes idle because the process is gone.
   - **Facts:**
     - **Liveness, for every agent:** if the agent is active or responded and the facts
       show no agent process in the foreground, the status becomes `idle`. The persisted
       lifecycle follows the existing `notifyAgentDetectorGone` behaviour: read the
       current `hook-relay.ts` bridge and keep its outcome.
     - **Not hook-driven:** facts decide every status: the output hint, title spinner or
       done markers for the matching **Agent kind** only, and the foreground process.
   - **Ticks:** port the three sweeps from `hook-relay.ts` `sweepStaleSessions` (stuck-working
     ADR-131, orphan ADR-132, held-Stop drain) as tick rules. They must use the same
     thresholds and the same outcomes.
   - **User signals:** `end`/`abandon` produce `idle` plus the lifecycle becoming
     `abandoned`/`completed`. Mirror what `agents:abandonForPane` and `/sessions/end` do
     today.
   - **Reasons:** every result carries a short human-readable `reason`.
3. Tests go in `electron/agent-status/__tests__/reconciler.test.ts`:
   - port every case in `hook-relay-transition.test.ts`, adjusted for no `complete`;
   - add table cases for each new rule;
   - add sequence tests ("these signals in order produce this status and reason") for the
     three known divergences: held Stop, child Stop, and title "✳ Done" on a
     hook-driven pane;
   - add a sequence test for an opencode pane driven only by facts.

Checks:
- `npx tsc --noEmit -p` over `tsconfig.json` (0 errors), `tsconfig.node.json` (0) and
  `tsconfig.electron.json` (baseline 7);
- `npx eslint` on the touched files;
- targeted vitest.

## Files to touch
- `electron/agent-status/types.ts`, `reconciler.ts` (new)
- `electron/agent-status/__tests__/reconciler.test.ts` (new)
- read-only references: `electron/hook-relay.ts`, `hook-relay-transition.ts`, `hook-relay-effects.ts`, `electron/terminal-host/agent-detector.ts`, `title-detector.ts`, `output-pattern-matcher.ts`, `electron/agent-hook-events.ts`
