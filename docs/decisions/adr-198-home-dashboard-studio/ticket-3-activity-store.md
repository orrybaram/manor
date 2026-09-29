---
title: Agent activity recorder store
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Agent activity recorder store

The timeline and two sparklines need history, and main publishes only current status. Record it in the renderer.

Create `src/store/agent-activity-store.ts` (zustand, matching the style of the other stores in `src/store/`):

- **State:**
  - `transitions: Record<paneId, { status: AgentStatus; at: number }[]>`
  - `samples: { at: number; waiting: number; working: number }[]`
  - `startedAt: number`
- **Recording:** a `startAgentActivityRecorder()` function subscribes to `useAppStore` (`paneAgentStatus`, see `src/store/app-store.ts:265`). It appends a transition when a pane's status differs from its last recorded one, and also records a pane's first status. Call it once at app start. Find where other app-level subscriptions start (grep for `useMountEffect` in `App.tsx`, or an `init`/`start` store function), and guard against double start.
- **Status mapping for samples:**
  - `waiting` = panes in `requires_input` or `error`.
  - `working` = panes in `working` or `thinking`.
- **Sampling:** take a sample immediately, then every 5 minutes (`setInterval`, cleared by a returned stop function).
- **Pruning:** drop transitions and samples older than 3 hours on each append/sample. Keep the latest transition before the window start, so a lane can show a segment that began before it. Cap each pane at 200 entries.
- **Pure helpers, exported and unit-tested:**
  - `laneSegments(transitions, windowStart, now)` → `{ status, from, to }[]`, clipped to the window, merging adjacent equal statuses and dropping `idle`.
  - `lanePriority`, which orders panes for display: needs you now > active now > most recent activity.
- It is memory only; no persistence. Expose `startedAt` so the UI can label "since HH:MM" when the recorder is younger than 3h.

Tests: `src/store/__tests__/agent-activity-store.test.ts` (match the existing test location convention). Use fake timers for sampling and pruning.

## Files to touch
- `src/store/agent-activity-store.ts` — new
- `src/store/__tests__/agent-activity-store.test.ts` — new (or wherever store tests live)
- `src/App.tsx` (or the existing app-init location) — start the recorder once
