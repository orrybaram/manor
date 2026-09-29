---
title: Agent activity timeline and PR pipeline panels
status: done
priority: high
assignee: sonnet
blocked_by: [5]
---

# Agent activity timeline and PR pipeline panels

Add two panels to the dashboard shell from ticket 5, matching `docs/decisions/adr-198-home-dashboard-studio/mockup.html` (default style). Use Manor tokens, not the mockup's hex values.

## `ActivityTimeline.tsx` (full width)

- Panel header: "Agent activity", with the sub-label "Last 3 hours" or "Since HH:MM" (use `agent-activity-store.startedAt` when it is younger than 3h). The legend on the right: Working (green), Thinking (accent), Waiting on you (red), Finished (cyan).
- Lanes come from `laneSegments` / `lanePriority` in `src/store/agent-activity-store.ts`. Show up to 6 lanes.
- Map each pane to its agent (`useAgentStore`, via the pane id) for the name. The project chip uses the agent's project colour (`projectColorStyle`). If there's no agent record, use the pane title.
- Row grid: name column (minmax 120–210px) | track | state column (56px).
- Track:
  - faint vertical gridlines at 30-min steps
  - segments absolutely positioned by percent of the window
  - `requires_input` / `error` periods use the red diagonal-stripe pattern, full track height
  - a live segment (one that ends now) has the ping dot, respecting `prefers-reduced-motion`
  - a finished marker (a cyan ring) where a pane went to `responded`; an errored marker (a red ring with ×) where it went to `error`
  - each segment has a `<Tooltip>` or `title` with "Working · 14:02 → 14:40"
- State column: the current state or its duration, in the state colour.
- Axis: 7 tick labels, "3h ago … now". With a shorter window, generate evenly spaced clock times instead.
- Clicking a lane → `navigateToAgent`.
- Re-render once a minute so "now" advances. Use one interval, cleaned up.
- Empty state: "No agent activity yet. Start one with ⌘N."
- Below 600px: hide the state column and the project chips.

## `PrPipeline.tsx` (span 7)

- Data: `prPipeline(projects, now)` from `src/lib/home-dashboard.ts`.
- Panel header: "Pull requests", sub-label "{n} open across {m} projects", and a right-side "All PRs →" only if a PR palette view exists (otherwise omit it).
- Four columns. Each header is a big count plus the stage label, with a 2px bottom border in the stage colour:
  - Checks running = yellow
  - In review = dim
  - Blocked = red
  - Ready = green
- Card (`<Button variant="ghost">` or a div with `role="button"`; mind nested buttons if you include `PrPopover`, see the existing Open PRs widget comment):
  - 2-line clamped title
  - blocked reason in red for blocked
  - meta: `#N`, project chip, check pips for the checks stage (one pip per check, coloured passing/running/failing), "queued" tag, and age right-aligned (peach when stale)
- Click → select the workspace. Reuse `selectWorkspaceOf` logic from `HomeDashboard.tsx`; lift it to a small hook if needed.
- Up to 3 cards per column, then a "+N more" link that expands that column.
- Empty state: "No open PRs."
- Below 600px: 2 columns.

## Files to touch
- `src/components/sidebar/HomeDashboard/ActivityTimeline.tsx` (+ CSS) — new
- `src/components/sidebar/HomeDashboard/PrPipeline.tsx` (+ CSS) — new
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` — mount them in their slots
