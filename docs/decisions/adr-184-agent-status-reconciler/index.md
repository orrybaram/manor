---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-184: One Status reconciler for Agent status

Domain terms (**Agent**, **Agent status**, **Status signal**, **Pane facts**,
**Hook-driven**, **Status reconciler**) are defined in `/CONTEXT.md`.

## Context

An **Agent**'s status is decided in three places today, and they disagree.

1. **Daemon.** `electron/terminal-host/agent-detector.ts` (`AgentDetector`) is a state
   machine with its own pieces:
   - a `hasBeenActive` flag;
   - a 2s hook debounce;
   - a 5s "complete" linger timer;
   - "gone" semantics.

   Three sources drive it: hook statuses pushed from main (`relayAgentHook`), fallback
   hints from `TitleDetector` and `OutputPatternMatcher` (wired inline in `session.ts`'s
   `MSG.DATA` handler), and foreground-process polling. It emits an `agentStatus` stream
   event.
2. **Main.** The hook relay (`hook-relay.ts` and `hook-relay-transition.ts`, ADR-139) is a
   second state machine. It has its own `hasBeenActive`, a `phase`, a `pendingStop` phase
   and a late-active guard. Three sweeps run outside that state machine, a gap ADR-139
   left out of scope. The two state machines are glued together by `relayAgentHook`
   (main to daemon) and `notifyAgentDetectorGone` (daemon to main, in `app-lifecycle.ts`'s
   `handleStreamEvent`).
3. **Renderer.** `useAgentDisplay.deriveStatus` chooses between the daemon's live status
   and the persisted `lastAgentStatus`, falling back to a static map. `useDebouncedAgentStatus`
   then adds another 500ms of debounce on top.

**Verified divergences:**
- A Stop held in `pendingStop` still sends `responded` to the dot right away, because
  `RelayAgentHook` is emitted before the pendingStop return.
- A child session's Stop is forwarded to the detector, so it can overwrite the root
  agent's dot.
- No hook ever produces `complete`. It is reached only by a Claude-only "✳ Done" title rule,
  which is applied to every **Agent kind**.
- The detector's process-polling signal does nothing: `updateForegroundProcess` is never
  given a pid, so `sweepStalePids` never finds anything to sweep.
- 16 `updateAgent(...)` call sites across 5 files write `status`/`lastAgentStatus`, and
  nothing guards the combination of the two fields. `deriveStatus` has to paper over
  states like "abandoned but responded".
- `handleStreamEvent` runs once per renderer window. Its agent side effects (renaming the
  agent from its title, and the "gone" bridge) therefore run N times.
- Tests pin behaviour that production never produces. There are 23 `setStatus("complete")`
  assertions and 0 for `responded`, which is what every real Stop sends. No test can
  assert "these signals produce this dot".

## Decision

A single pure **Status reconciler** in Electron main decides every pane's **Agent status**.
Everything else becomes a source of **Status signals** or a consumer of what the
reconciler publishes. The decisions below were made in a design session and are recorded
in `CONTEXT.md`.

### 1. The reconciler (`electron/agent-status/`)

A pure per-pane function:
`reconcile(state, signal, ctx) → { state, status, reason, effects }`.

**Signals** form a sealed union:
- `hook`: the existing typed `AgentHookEvent` (`agent-hook-events.ts`).
- `paneFacts`: a snapshot from the daemon.
- `tick`: the current monotonic time.
- `user`: a user action, such as ending or abandoning the agent, or marking it seen.

**Rules** each become a row in the transition table:
- **Root and children.** A pane has one root session. A child session can raise the pane
  to thinking, working or requires input while the root's turn is in progress. Only the root's own
  signals can end a turn (`responded`, `error`, `idle`).
- **Hook-driven.** An **Agent** becomes hook-driven the first time its root session sends
  any hook, and stays that way until the session ends.
- **Hook-driven agents.** Hooks decide the turn statuses. **Pane facts** decide only
  liveness: if the agent process is gone, the status becomes `idle`. This replaces the
  "gone" bridge.
- **Agents that are not hook-driven** (opencode, or a kind whose hooks failed to register).
  **Pane facts** decide every status, from the foreground process, title and output hint.
- **Time-based rules** run on `tick`: the stuck-working safety net (ADR-131), orphan
  recovery (ADR-132), and draining a held Stop. They are no longer separate sweeps.
- **No `complete` status.** A finished turn is `responded`. An ended session is `idle`,
  and the **Agent**'s lifecycle becomes `completed`.
- The late-active guard, the held-Stop-while-subagents-are-active rule, and the
  SessionStart root replacement carry over from ADR-139's `transitionSession`, where they
  already exist as rows.

**Effects** are data: persist the agent's lifecycle and last status, create the agent,
broadcast it, notify, update unseen/badge state, and publish the pane's status. A thin
driver (`electron/agent-status/driver.ts`) holds the per-pane states, feeds signals in,
applies effects exactly once per signal regardless of how many windows are open, and
schedules the tick. It replaces `createHookRelay`'s interior. The effect applier from
ADR-139 is reused and extended.

**Reason.** Every result carries a short `reason`, for example "Stop hook",
"agent process exited" or "no hook for 60s (stuck-working recovery)". It is published with
the status, shown as the dot's tooltip, and written to the agent-status debug log.

### 2. The reconciler is the only writer of the persisted agent status

The **Agent**'s lifecycle (`active`/`completed`/`abandoned`/`error`) and its last
**Agent status** are written only by reconciler effects. User actions that change them
enter as `user` signals:
- `agents:abandonForPane`;
- `/sessions/end`;
- deleting or ending an agent through IPC or routes.

The other 16 `updateAgent(...)` status writes go away. Name, title and cwd updates are not
status, and stay where they are.

### 3. The daemon sends Pane facts, not status

`AgentDetector`, `TitleDetector` and `OutputPatternMatcher` collapse into one daemon-side
**Pane facts** extractor (`electron/terminal-host/pane-facts.ts`): terminal bytes, OSC
titles and the foreground process go in, facts come out.

`PaneFacts` has three fields:
- `foreground`: `{ name, kind | null }`;
- `title`: `string | null`;
- `outputHint`: `{ hint, at } | null`.

Delivery:
- A new stream event `{ type: "paneFacts", sessionId, facts }` fires when the facts change.
- A new control request `getPaneFacts` returns the current snapshot, so main can resync
  after a reconnect with nothing to replay.

Removed:
- the `agentStatus` stream event;
- the `relayAgentHook` request and `PtyBackend.relayAgentHook`;
- `notifyAgentDetectorGone`;
- the dead pid sweep;
- `setAltScreen`.

Remote hosts work unchanged: hooks still arrive through the hook journal (ADR-178), and
facts arrive through the stream plus a resync on connect.

### 4. The renderer displays and does not decide

Main publishes one `{ status, reason, kind }` per pane on a single channel (`agent-status`).
It replaces `pty-agent-status-*`.

Deleted:
- `deriveStatus`;
- `useDebouncedAgentStatus`;
- the `lastAgentStatus` fallback logic.

Aggregation across panes (`pickBestPaneStatus` for tab/workspace/project dots) stays,
because it summarises and does not decide.

Changes:
- `AgentDot` loses `complete` and shows `reason` as its tooltip.
- `workspace-indicator` and the remote client (`src/remote-client/main.ts`) lose `complete`.
- The agents list shows a `completed` lifecycle as a lifecycle badge rather than as a
  status dot.

## Consequences

**Better:**
- One place answers "why is this dot like this?", and it now says why in the tooltip.
- The known divergences are fixed as rows in one table rather than as new guards:
  - a held Stop showing as responded;
  - a child's Stop overwriting the root's dot;
  - the random `complete`;
  - N-times per-window side effects.
- Tests become "these signals in this order produce this status and reason". They run with
  no PTY, no timers and no fake clocks, across hooks, facts and ticks.
- ADR-139's deferred follow-up is done: the sweeps and the detector bridge join the state
  machine. The daemon gets simpler, and its only job is facts.

**Harder or risky:**
- **Fallback flicker returns for non-hook agents only.** That is intended, but opencode's
  statuses will depend entirely on facts heuristics.
- **Wire protocol change.** `agentStatus` and `relayAgentHook` are removed and
  `paneFacts`/`getPaneFacts` are added. Old daemons are replaced by the version handshake,
  and dev boxes need a daemon reinstall (see ADR-183).
- **Effect ordering is load-bearing**, as in ADR-139. The relay's integration tests pin the
  ordering of notification, broadcast and unseen updates, so carry those orderings over
  explicitly.
- **Big-bang risk.** Mitigated by sequencing. The reconciler is built and table-tested
  first, unwired. Facts are added alongside the old event. Main switches over in one
  ticket. Old paths are deleted only after that.

**Supersedes and extends:**
- Supersedes the detector design of ADR-012, ADR-014 and ADR-015, and ADR-138 ticket 4's
  "audit, don't rewrite".
- Completes ADR-139's out-of-scope items (sweeps, the detector bridge).
- Extends ADR-136's single-writer principle to agent status.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
