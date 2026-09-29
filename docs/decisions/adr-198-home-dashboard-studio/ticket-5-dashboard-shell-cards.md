---
title: Dashboard page shell, header, host alert, stat tiles and Needs you cards
status: done
priority: critical
assignee: opus
blocked_by: [2, 3, 4]
---

# Dashboard page shell, header, host alert, stat tiles and Needs you cards

Replace Home's list dashboard with the Studio page from `docs/decisions/adr-198-home-dashboard-studio/mockup.html`. Use the default style only; ignore the style switcher and the `calm` / `terminal` / `mission` CSS. Read ADR-198 §1, §2 and §4 first. Match the mockup's spacing, radii, type scale and colours, using Manor tokens (`src/App.css` `:root`) instead of the mockup's literal hex values and fonts.

## Page shell

- `src/components/sidebar/HomeEmptyState.tsx` renders the new dashboard **without** `EmptyStateShell`. Keep the `testId="home-view"` on the root.
- New `HomeDashboard` layout:
  - scrollable
  - `max-width: 1180px`, centred, with padding
  - `container-type: inline-size` on the Home pane wrapper
  - a 12-column grid that stacks below 900px (container query)
- Put new components under `src/components/sidebar/HomeDashboard/`, one component per file (`.claude/skills/react` conventions). Suggested files: `DashboardHeader.tsx`, `HostAlert.tsx`, `StatTiles.tsx`, `Sparkline.tsx`, `NeedsYouCards.tsx`, `NeedsYouCard.tsx`. Use one CSS module per component, or one shared `HomeDashboard.module.css`, whichever matches nearby code.
- Remove the old list sections (Needs you rows, Up next rows, Open PRs rows, summary line, clearline) and their dead CSS. Tickets 6 and 7 add Pipeline, Timeline, Up next and Projects into slots you leave in the layout. Render simple placeholders or nothing for them, but keep the grid positions: timeline full width; pipeline span 7 + Up next span 5; project tiles full width.

## Header

- Date eyebrow, then the `headline()` sentence. `lead` is coloured red when something needs you, and plain otherwise.
- Buttons, right-aligned, using `<Button>`:
  - New agent ⌘N (`onNewAgent`, which `HomeEmptyState` already receives)
  - Open terminal ⌘T (`addTab`)
  - Command palette ⌘K (the same keydown dispatch `HomeEmptyState` uses today)
- New agent is the primary style.

## Host alert

- Shown when any host used by a project is offline or failing (`src/store/host-store.ts`, `src/lib/host-status.ts`).
- Text: "**{host}** went offline {age} ago. Status for {n} workspaces may be out of date." Use the failure time if available; otherwise omit the age.
- Action: Reconnect → `retryConnect`.
- One strip per offline host, max 2.

## Stat tiles (4)

- `Sparkline.tsx`: a pure SVG component for `values: number[]` with a `bars` variant. Area fill at ~13% opacity, a 1.6px line with `vector-effect: non-scaling-stroke`, and an emphasised endpoint dot. It must draw to scale, and return nothing for fewer than 2 points.
- **Waiting on you:**
  - count = visible (non-snoozed) Needs you agent + PR cards
  - foot: "Longest: {age} · {what}"
  - sparkline from `agent-activity-store` samples (`waiting`)
- **Agents working:**
  - count of working/thinking panes
  - foot: "since HH:MM" if the recorder is younger than 3h
  - sparkline from samples (`working`)
- **Open PRs:**
  - `openPrStats`: count and oldest age
  - a stacked stage bar: Checks = yellow, Review = dim, Blocked = red, Ready = green
  - a legend with counts
- **Merged this week:**
  - sum of `dailyPrsMerged` from the stats store
  - bars sparkline; today's bar full opacity, others ~45%
  - hide the tile's chart if stats are disabled

## Needs you cards

- The panel header has "Needs you" and a sub-label. Cards are in a CSS grid, `repeat(auto-fill, minmax(260px, 1fr))`.
- Data: `needsYouCards(..., useActiveSnoozes())`. Show 5, then a dashed "+N more" tile that expands.
- Card anatomy:
  - kind label with icon, in the tier colour
  - project chip
  - age
  - title (agent name / "#N PR title")
  - context block (mono, inset) rendered per `context.kind`:
    - failing check names with "✕"
    - diff +/− with a proportional bar
    - "✓ Approved · ✓ 7/7 checks"
    - …
  - footer: primary `<Button>` tinted with the tier colour, secondary `<Button>`, and a ghost Snooze
- Actions exactly per the ADR §4 table.
  - Fix with agent: use `startAgentWithPrompt(workspace.path, prompt, project.hostId)` from `src/lib/agent-prompt-launch.ts`. The prompt names the PR, each failing check and its URL, and asks the agent to reproduce and fix locally and push.
  - Check-run links use `<Link>`.
- Empty state: when there are no cards, the panel shows one calm line, "Nothing needs you right now." It is not hidden, so the layout stays stable.
- Keep keyboard access: cards are not buttons themselves; their buttons are focusable.

## Files to touch
- `src/components/sidebar/HomeEmptyState.tsx`
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` and `.module.css`
- new: `DashboardHeader.tsx`, `HostAlert.tsx`, `StatTiles.tsx`, `Sparkline.tsx`, `NeedsYouCards.tsx`, `NeedsYouCard.tsx` (+ CSS) in `src/components/sidebar/HomeDashboard/`
