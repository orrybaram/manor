---
type: adr
status: proposed
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

# ADR-199: Record agent activity in main and keep it on disk

## Context

ADR-198's Agent activity timeline records status changes in a renderer store
(`src/store/agent-activity-store.ts`). ADR-198 accepted that history would be
lost on reload. In practice that makes the timeline useless:

- **It starts empty on every launch or reload.** The header reads "Since
  11:42 AM", and a 2-minute window is stretched across the full width, so the
  tick labels repeat ("11:42, 11:42, 11:43…").
- **"Finished" is drawn as a bar.** After a launch, every agent's first
  recorded status is `responded`, so each lane is one full-width cyan bar
  with a ring at the start. Six lanes of "done" say nothing.
- **Lanes are keyed by pane id.** Panes are ephemeral, so a lane can't
  outlive its pane, and the name falls back to "Agent".
- **Sparklines need 10 minutes after each launch** before they show
  anything, because they come from 5-minute samples.

Main already sees every status change in one place: the Status reconciler's
`publishPaneStatus` in `electron/app-lifecycle.ts` (~line 577). Main has also
outlived renderer reloads since ADR-184. It already persists usage stats with
a debounced JSON store (`electron/stats-store.ts`), and resolves panes to
Agents with `agentManager.getAgentByPaneId`.

## Decision

### 1. `AgentActivityStore` in main

- Add `electron/agent-activity-store.ts`, modelled on `StatsStore`. It is
  backed by `agent-activity.json` in the same data dir, with a debounced
  write (2s) and a flush on quit.
- **Record per Agent, not per pane.** In `publishPaneStatus`, resolve
  `agentManager.getAgentByPaneId(update.paneId)`. Then append
  `{ status, at: Date.now() }` to that Agent's list when the status differs
  from the last entry. Panes with no Agent are skipped.
- **Keep a small meta snapshot per Agent**, refreshed on each record:
  `{ name, projectId, workspacePath, hostId }`. A lane can then still be
  named and coloured after the Agent is deleted.
- **Record app sessions:** `{ start, end }`. `start` is set at construction.
  `end` is updated whenever the store saves and on quit. The UI shades the
  gaps between sessions as "Manor closed", because nothing was observed
  then. Agents in the daemon may still have run during those gaps.
- **Retention:** 24 hours. Prune on each save, keeping the last transition
  before the cutoff so a lane's first segment can start before it. Cap each
  Agent at 500 entries and keep at most 200 Agents, dropping the least
  recently active.
- **Corrupt or missing file:** start empty. Never throw at startup.

### 2. IPC

- `agentActivity:get` returns `AgentActivitySnapshot`:
  `{ agents: Record<agentId, { meta, transitions }>, sessions, now }`.
- `agentActivity:changed` pushes the same snapshot, debounced 1s like
  `stats:changed` (`electron/ipc/stats.ts`). The payload is small: 24h ×
  tens of agents × a handful of transitions.
- Expose both in `electron/preload.ts`, and type them in `src/electron.d.ts`.

### 3. Renderer

- `src/store/agent-activity-store.ts` becomes a cache, like
  `src/store/stats-store.ts`. It loads with `agentActivity:get` at start and
  subscribes to `agentActivity:changed`. The renderer recorder and 5-minute
  sampler are removed.
- **Sparklines are computed from transitions.** A new pure helper,
  `statusCountSeries(snapshot, start, end, step, predicate)`, returns the
  number of Agents in a matching status at each step. It uses 15-minute
  steps over 3 hours and ends with a live point, so a sparkline has data as
  soon as there's history.
- **`laneSegments` changes:**
  - Drop `responded` as well as `idle`. Finished is a marker, not a bar.
  - Clip segments to recorded sessions, so nothing is drawn across a
    "Manor closed" gap.

### 4. Timeline UI

- **Always a fixed 3-hour window.** Where there's no history, the track is
  empty (history before the file existed shows as "no data"), not stretched.
  The 7 ticks are "3h ago … now". The sub-label is always "Last 3 hours".
  This fixes the duplicate ticks.
- **Closed-app gaps** draw as a faint diagonal hatch, with the tooltip
  "Manor closed".
- **Lanes:** show Agents that were working, thinking or waiting within the
  window, ordered by `lanePriority` (needs you now > active now > most recent
  activity), up to 6. An Agent that only sat at `responded` or `idle` gets no
  lane.
- **Markers:** a finished marker (cyan ring) wherever the status became
  `responded`, and an errored marker where it became `error`.
- **Lane name:** the Agent's name, falling back to the workspace name and
  then the branch. The project chip colour comes from `meta.projectId`.
- **Legend:** Working, Thinking and Waiting on you as bars; Finished as a ring.

## Consequences

**Better**

- The timeline shows real history the moment Home opens, including across
  reloads and restarts, for up to 24h.
- Sparklines work immediately and there's no sampler timer.
- Lanes follow Agents, so they have stable names.
- The main-side store is the natural home for later features such as
  "waiting since", longer windows, or per-agent time totals.

**Harder / risks**

- **Another file in the data dir** with a write every couple of seconds while
  agents are busy. The debounce and small payload keep this cheap.
- **Nothing is recorded while Manor is closed**, even though the daemon may
  keep agents running. The gaps are drawn honestly rather than guessed at.
- **Remote hosts:** statuses from remote panes flow through the same
  reconciler, so they're recorded too. Clock skew doesn't matter, because
  `at` is main's own clock.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
