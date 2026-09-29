---
title: Timeline UI on persisted history
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Timeline UI on persisted history

Implement ADR-199 §4 in `src/components/sidebar/HomeDashboard/ActivityTimeline.tsx`, `TimelineLane.tsx`, `timeline-model.ts` and `ActivityTimeline.module.css`.

- **Window:** always a fixed 3-hour window. Remove the partial-window logic from `timelineWindow`. The sub-label is "Last 3 hours". The 7 ticks read "3h ago", "2h 30m ago", …, "now". Before the first recorded session there is no track fill ("no data").
- **Lanes** come from the snapshot's agents via `lanePriority` (up to 6).
  - Name: `meta.name`, then the workspace name (look it up in `useProjectStore` by `meta.projectId` + `meta.workspacePath`), then the path basename.
  - The chip colour comes from the project.
  - Click → `navigateToAgent` if the Agent still exists in `useAgentStore`.
- **Track:**
  - segments from the new `laneSegments`
  - markers from `laneMarkers`
  - closed-app gaps from `closedGaps`, drawn behind segments as a faint diagonal hatch (`--hd-fg-4`) with `title="Manor closed"`
- **State column:** the current status label or its duration, in the status colour. "Finished" shows how long ago.
- **Legend:** Working, Thinking and Waiting on you as bars; Finished as a small ring (not a bar).
- Remove `responded` from any bar colour usage.
- Keep the existing animation (`useDashboardAnimate`), the segment transitions, the empty state and the narrow-container rules.

## Files to touch
- `src/components/sidebar/HomeDashboard/ActivityTimeline.tsx`, `TimelineLane.tsx`, `timeline-model.ts`, `ActivityTimeline.module.css`
