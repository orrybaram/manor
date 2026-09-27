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

# ADR-186: Keep the pane working while background subagents run

## Context

When Claude Code launches a subagent with `run_in_background: true`, the root
session ends its turn ("Waiting for 1 background agent to finish") while the
subagent keeps working. Manor then shows the pane and its Agent as
**responded** even though work is still going on.

We captured the real hook order by running `claude -p` with a logging hook
on every event:

Foreground subagent:

```
UserPromptSubmit
PreToolUse       tool=Agent
SubagentStart    agent_id=ae8b…         (no tool_use_id)
PreToolUse       agent_id=ae8b… tool=Bash
PostToolUse      agent_id=ae8b… tool=Bash
SubagentStop     agent_id=ae8b…         (no tool_use_id)
PostToolUse      tool=Agent
Stop
```

Background subagent (the subagent ran `sleep 20` first):

```
UserPromptSubmit
PreToolUse       tool=Agent
PostToolUse      tool=Agent
SubagentStart    agent_id=a0bc…
Stop                                     ← root turn ends; subagent still running
                                           (20s with no hooks)
PreToolUse       agent_id=a0bc… tool=Bash
PostToolUse      agent_id=a0bc… tool=Bash
SubagentStop     agent_id=a0bc…
UserPromptSubmit                         ← Claude resumes to report the result
Stop
```

Facts from the capture:

1. Every hook carries the **root's `session_id`**. The subagent's hooks
   (including its tool hooks) add an `agent_id`; the root's own hooks have none.
2. `SubagentStart` / `SubagentStop` carry `agent_id` but **no `tool_use_id`**.
   ADR-130 keyed `activeSubagents` by `tool_use_id`, so today every key is a
   `__fallback_N` placeholder and the start/stop pairing is by count.
3. Subagents no longer send `Stop`. A `Stop` held for active subagents
   (ADR-033 / ADR-130) now only happens with background subagents.
4. When the last background subagent finishes, Claude resumes with
   `UserPromptSubmit`, which Manor already treats as a new turn.

What goes wrong in `electron/agent-status/reconciler.ts`:

- **H7** holds the root `Stop` because `activeSubagents.size > 0`. Correct.
- **T1** (ADR-130's held-Stop drain) applies the held Stop once the root
  session has been quiet for `STALE_STOP_MS` (15s). A background subagent
  often goes 15s without a hook: a long model think, a `vitest` / `tsc` run,
  a `sleep`. T1 then marks the turn responded and clears `activeSubagents`.
- **H1** (the late-active guard) then drops every later hook from that
  session as "late hook after Stop", including the subagent's. The pane stays
  responded until the next `UserPromptSubmit`.

T1 used a short timeout because the count-based pairing could get out of
sync. With `agent_id` the pairing is exact, so the short drain is no longer
needed when every active subagent has a real id.

## Decision

### 1. Forward `agent_id` from the hook script

`electron/scripts/agent-hook.js` reads `payload.agent_id` (string or null)
and sends it as an `agentId` query parameter, next to `toolUseId`.

`electron/agent-hook-events.ts` adds `agentId: string | null` to `EventBase`,
so every event variant has it (tool hooks come from subagents too). Missing
means null. The remote daemon's journal forwards all query params unchanged,
so it needs no change.

### 2. Key subagents by `agent_id`

In `reconcileRootHook`, a subagent's key is `agent:<agentId>`, else
`tool:<toolUseId>`, else `__fallback_N` (see §4 for why keys are tagged). `SubagentStop`
removes that key; if neither id is present, it removes one entry as it does
today. `SubagentStop` also adds the key to a new
`finishedSubagents: ReadonlySet<string>` on `PaneAgentState`, so a hook from
a finished subagent that arrives late is recognised. The set is cleared with
the rest of the turn state (`withoutRoot`, SessionStart replacement,
StopFailure).

### 3. Subagent hooks never change the root's turn phase

A root-session hook with a non-null `agentId` is a **subagent hook**. It is
handled before the normal root-hook rules:

- It always updates `lastHookAt`, which feeds T1 / T2.
- It never sets `phase`. A subagent's `PreToolUse` during `pendingStop` no
  longer flips the phase back to `active`. Only the root's own hooks (no
  `agentId`) start or end turns.
- `SubagentStart` adds the id. `SubagentStop` removes it and adds it to
  `finishedSubagents`.
- Status and persistence:
  - **Phase `active` or `pendingStop`.** Active statuses from the subagent
    show on the pane as they do today (working / thinking / requires_input).
    The same `PersistAgentStatus` / `CreateAgent` effects as a root active
    hook apply, but the phase is unchanged.
  - **Phase `responded` / `stalled` / `none`.** The late-active guard (H1)
    is relaxed for subagent hooks only:
    - `SubagentStart` for an id not in `finishedSubagents` **reopens** the
      turn: phase `pendingStop`, `pendingStopAt = nowMs`, status `working`,
      Agent persisted active / working. This covers a `Stop` that raced ahead
      of `SubagentStart` over HTTP.
    - An active hook whose `agentId` is in `activeSubagents` reopens the same
      way.
    - Any other subagent hook (unknown id, or an id in `finishedSubagents`)
      is dropped as late.
- Terminal statuses from a subagent hook other than `SubagentStop` are
  ignored. Subagents don't send `Stop` / `SessionEnd`, and if one did it
  must not end the root's turn.

H1 is unchanged for root hooks (no `agentId`).

### 4. Held-Stop drain (T1) depends on what we are waiting for

In `reconcileTurnTick`, when `pendingStopAt !== null`:

- If every key in `activeSubagents` is a real `agent_id`, drain only
  after `STALE_SUBAGENT_MS = 15 * 60_000` without a hook. This is a last
  resort for a lost `SubagentStop`. Bash's own timeout is at most 10
  minutes, so 15 minutes covers a single long command.
- Otherwise (fallback keys, or no active subagents left and still waiting for
  the resume `UserPromptSubmit`), keep `STALE_STOP_MS` (15s) as today.

To make this exact, keys are tagged: `agent:<agent_id>`, `tool:<tool_use_id>`,
or `__fallback_N`. T1 uses the long threshold when
`activeSubagents.size > 0` and every key starts with `agent:`.

T2 (stuck-working) already skips `pendingStop` (it needs phase `active`).
With rule 3 a subagent hook no longer moves `pendingStop` to `active`, so T2
can't close a turn that is waiting on a background agent. F1 (agent process
gone) and `SessionEnd` still clean up a crashed or exited session right away.

### 4a. Decisions added during implementation

- **A root `UserPromptSubmit` clears a held Stop.** The turn Claude resumes
  once the last background subagent finishes is a new turn. Otherwise the old
  `pendingStopAt` would let T1 drain it 15s into a long think, and the root's
  real `Stop` would then save a second `responded`.
- **Subagent activity in a `stalled` turn resumes it** (phase `active`),
  as a root hook does. T2 clears the subagent keys when it stalls a turn, so
  the "id in activeSubagents" reopen rule couldn't match.
- **T2 uses `STALE_SUBAGENT_MS` too** while every active subagent has an
  `agent:` key. A *foreground* subagent inside one long tool call (a test
  run over 60s) sends no hooks either, and would otherwise be stalled to
  responded.

### 5. Tests

Add these cases to `electron/agent-status/__tests__/reconciler.test.ts`:

- Background flow from the capture above, with a 20s quiet gap after `Stop`:
  the pane stays working throughout, `SubagentStop` leaves it
  `pendingStop`, and `UserPromptSubmit` then `Stop` ends at responded with
  exactly one `responded` persistence.
- T1 does not drain after 20s when the active subagent has an `agentId`;
  it does drain after `STALE_SUBAGENT_MS`.
- T1 still drains after 15s when the keys are fallback / toolUseId only.
  Existing ADR-130 tests keep passing.
- `Stop` arriving before `SubagentStart` (HTTP race): `SubagentStart` with an
  `agentId` reopens the turn.
- A late subagent `PostToolUse` whose `agentId` is in `finishedSubagents`,
  arriving after the root `Stop`, is dropped.
- A subagent `PreToolUse` during `pendingStop` leaves the phase at
  `pendingStop`.
- A root `PreToolUse` (no `agentId`) after `Stop` is still dropped (H1
  unchanged).

Also update `electron/__tests__/agent-hook-script.test.ts` (forwards
`agentId`) and the parser tests (`agentId` parsed on every variant).

## Consequences

- **Better:** a pane with background agents stays working until the agents
  and the resumed turn finish, so no false "responded" dot or notification.
  Start/stop pairing is exact instead of by count.
- **Better:** a subagent's tool hooks can't reset the root's turn phase, so
  "held Stop" means one thing.
- **Risk:** a lost `SubagentStop` for a real agent id now leaves the pane
  working for up to 15 minutes, instead of 15 seconds. The process-exit (F1)
  and `SessionEnd` paths still recover at once when Claude exits. A lost
  `SubagentStop` is much less likely than before, because it was the
  count-based pairing that made it look lost.
- **Not covered:** `activeSubagents` is not persisted, so after a Manor main
  restart (`stateFromSavedAgent`) a pane loses track of running background
  agents. Its next subagent hook reopens the turn only if it is a
  `SubagentStart`. That's acceptable for now.
- **Not covered:** background *Bash* shells (`run_in_background` on Bash)
  send no subagent hooks, so they still show responded while running. That's
  a separate problem.
- Older Claude Code versions without `agent_id` fall back to the current
  behaviour (fallback keys, 15s drain).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
