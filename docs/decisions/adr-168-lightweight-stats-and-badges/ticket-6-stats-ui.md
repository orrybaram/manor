---
title: Stats palette view, status bar segment, settings toggle
status: done
priority: medium
assignee: opus
blocked_by: [5]
---

# Stats palette view, status bar segment, settings toggle

ADR-168 §6. Use components from `src/components/ui/` (`Button`, `Tooltip`, `Switch`) — never raw `<button>`.

## Required behavior

**Palette view**
- `src/components/command-palette/types.ts`: add `"stats"` to `PaletteView`.
- New `src/components/command-palette/StatsView.tsx`, structured like `ProcessesView.tsx`. Reads `useStatsStore`. Renders:
  - Header line: `🔥 {streakDays}-day streak` (or "No streak yet").
  - A table with columns Today / 7 Days / All Time and one row per `StatCounter` except `unblockMsTotal` and `fastUnblocks` (folded into a derived "Unblock time" row via `formatUnblockLatency`, and a "Fast unblocks" row respectively). Row labels from `humanCounterLabel`. Order: prompts, toolCalls, agentSessions, subagents, agentsResponded, agentsKilled, blocks, unblocks, unblock time, fastUnblocks, maxConcurrentAgents, worktreesCreated, worktreesRemoved, worktreesMerged, prApproved, prChangesRequested, prChecksFailed. Zero values render as `–`.
  - Badges strip: earned badges from `BADGES` titles (import the list via a renderer-safe mirror `src/lib/badges.ts` that re-exports id/title/description only — do **not** import from `electron/`), each with a `Tooltip` showing description + awarded date. Unearned badges shown dimmed with title only.
  - Empty state when `summary === null` or `enabled === false`: "Stats collection is off. Enable it in Settings → General."
- Footer: `ResetStatsFooter` mirroring `KillAllFooter` (confirm dialog, then `useStatsStore.getState().reset()`).
- `CommandPalette.tsx`: add `view === "stats"` branches wherever `"processes"` is handled (title "Stats", back navigation, detail-view gating, footer). Add `navigateToStats` alongside `navigateToProcesses` and pass it into `useCommands`.
- `useCommands.tsx`: root command `{ id: "show-stats", label: "Show Stats", icon: <BarChart3 /> (lucide `bar-chart-3`), category same as Processes }` calling `navigateToStats()`.

**Status bar** `src/components/statusbar/StatusBar/StatusBar.tsx`, right side before the logo button:
- Segment text: `🔥 {streakDays} · {today.prompts} prompts · ☠ {today.agentsKilled}`. Hide entirely when `summary` is null, `enabled` is false, or `allTime.prompts === 0 && allTime.agentsKilled === 0`.
- Wrapped in `Tooltip` with a compact today summary (prompts, tool calls, kills, unblock time).
- Click opens the command palette at `initialView: "stats"`. Find how the StatusBar (or its parent) currently opens the palette / how `initialView` is threaded (`onViewAllAgents` is the closest precedent); reuse that plumbing rather than adding a global.
- Styles in `StatusBar.module.css`, matching existing `segment` tokens.

**Settings** `src/components/settings/GeneralSettingsPage.tsx`:
- `Switch` "Collect usage stats" bound to `preferences.statsEnabled` with a one-line description ("Counts prompts, tool calls, worktrees and agents killed. Never stores text. Stays on this Mac.").
- `Button` "Reset stats" (danger variant if one exists) that calls `useStatsStore.getState().reset()` after the same confirm dialog pattern used elsewhere in settings.

## Verification
- `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- Manually: open palette → "Show Stats" renders; killing a pane with an agent mid-run bumps `☠` in the status bar within ~1 s; toggling the pref off hides the segment and shows the empty state.

## Files to touch
- `src/components/command-palette/types.ts` — view id
- `src/components/command-palette/StatsView.tsx` — new
- `src/components/command-palette/CommandPalette.tsx` — view wiring
- `src/components/command-palette/useCommands.tsx` — command
- `src/components/command-palette/CommandPalette.module.css` — table styles if needed
- `src/lib/badges.ts` — renderer mirror of badge id/title/description
- `src/components/statusbar/StatusBar/StatusBar.tsx` + `.module.css` — segment
- `src/components/settings/GeneralSettingsPage.tsx` — toggle + reset
