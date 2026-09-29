---
title: Renderer activity cache, count series and segment rules
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Renderer activity cache, count series and segment rules

Implement ADR-199 §3.

- Rewrite `src/store/agent-activity-store.ts` as a cache of `AgentActivitySnapshot`, like `src/store/stats-store.ts`:
  - load with `window.electronAPI.agentActivity.get()` at app start, then subscribe to `onChanged`
  - replace `startAgentActivityRecorder` in `src/App.tsx` with the loader
  - remove the renderer recorder, the sampler and `samples`
- Pure helpers, exported and tested in `src/store/__tests__/agent-activity-store.test.ts` (rewrite the tests):
  - `laneSegments(transitions, windowStart, now, sessions)`:
    - clip to the window
    - drop `idle` **and** `responded`
    - merge adjacent equal statuses
    - clip segments to `sessions`, so nothing crosses a closed-app gap (the open session's `end` is `now`)
  - `laneMarkers(transitions, windowStart, now)` → `{ kind: "finished" | "error"; at }[]`
  - `closedGaps(sessions, windowStart, now)` → `{ from, to }[]`
  - `lanePriority(agents, windowStart, now)`: only Agents with a working/thinking/requires_input/error segment inside the window; ordered needs you now > active now > most recent activity
  - `statusCountSeries(agents, start, end, stepMs, predicate)` → `number[]`, one value per step plus a final point at `end`
- Update `StatTiles.tsx` so the Waiting on you and Agents working sparklines use `statusCountSeries`: 3 hours, 15-minute steps, predicate waiting = `requires_input | error`, working = `working | thinking`. Remove the "since HH:MM" foot text; use "last 3 hours".

## Files to touch
- `src/store/agent-activity-store.ts`, `src/store/__tests__/agent-activity-store.test.ts`
- `src/App.tsx`
- `src/components/sidebar/HomeDashboard/StatTiles.tsx`
