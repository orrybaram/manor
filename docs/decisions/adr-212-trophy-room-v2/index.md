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

# ADR-212: Trophy Room v2 and the unlock toast

## Context

ADR-168 added local stats and badges. The rack has since grown to 40 badges in 8 tracks with bronze, silver and gold tiers (`electron/stats-badges.ts` decides who has earned what; `src/lib/badges.ts` mirrors it for display). Everything renders in `src/components/command-palette/StatsView.tsx` as one long scroll: stat tiles, contribution graph, stat table, then every track as a grid of cards.

Problems with that:
- Finishing a track just flips its header to "Complete". There's no reward and nothing after it.
- Locked badges spoil themselves: title, tier and progress all show, so joke badges have no surprise.
- Badges and raw stats compete for the same scroll.
- An unlock only shows as a row in the notification popover, so most people never see it happen.

The design canvas "Manor Achievements — Presentation Ideas" (https://claude.ai/artifact/8h5YB8G6e7me2z9nKJXXYU), boards 6a "Trophy Room v2" and 6b "Unlock toast", borrows from console trophy screens to fix this. This ADR builds those two boards.

## Decision

### Model (`src/lib/badges.ts`, `electron/stats-badges.ts`)

- **Track completion.** A track is **complete** when every badge in it is earned. (An earlier cut of this ADR split each track into "seal" and "gild" tiers; that was dropped as too confusing — see the revision note below.)
- **Titles.** `BadgeSectionMeta` gains `title` (the reward name, e.g. Staff → "Master of the House"). Completing a track earns its title. All of this is derived from `summary.badges`, so nothing new is stored.
- **Secret badges.** `BadgeMeta` gains `secret?: boolean` for a few joke or surprise badges. While locked, a secret badge shows `???`, a `?` medal, and no tier or progress. A **Reveal** button shows it to you, and that choice is saved.
- **Platinum.** A fourth tier, `platinum`, with one badge (`platinum`, titled "Lord of the Manor", "Earned every other badge") added to both copies. `earned` in main reads `summary.badges`, so it is awarded on the next commit after the last other badge. The rack goes from 39 to 40 badges.
- Pure helpers in `src/lib/badges.ts`: `trackState(section, summary)` → `{ earned, total, complete }`, `earnedTitles(summary)`, `tierTally(summary)`. These get unit tests.

### Persistence

Two new `AppPreferences` keys, going through the existing preferences store and IPC: `achievementTitle: string | null` (the title you chose to display; null means the most recent one earned) and `revealedBadges: string[]`. Neither is a stat, so neither belongs in `stats.json`. Nothing leaves the machine, which keeps ADR-168's promise.

### Trophy Room v2 (`StatsView.tsx` split into `src/components/command-palette/trophy-room/`)

- **Header:** your selected title, with a pencil button that opens a menu of earned titles. On the right: earned / total, a tier-segmented bar, and the tally (bronze, silver, gold, platinum).
- **Tabs:** Badges and Stats, in the same pattern as the other tab rows in the palette.
- **Badges tab:** a track sidebar on the left (Summary, then each track with `n/m` or "complete"), and the selected track on the right:
  - a track card ("Complete it to earn the title X", one progress bar);
  - a row list: medal, name, tier, description, a progress bar for the next locked badge, and the unlock date;
  - **Summary** shows "Next up" (the closest locked badge in each incomplete track) and recent unlocks.
- **Stats tab:** today's stat tiles, contribution graph and stat table, moved over unchanged.
- **Medals:** keep the existing emoji icons and the `--badge-color` treatment. Locked medals use a dashed ring.
- Styles go in a new `TrophyRoom.module.css`, and the old `.achievement*` rules are removed from `CommandPalette.module.css`. Use `ui/` components (`Button`, `Tooltip`) per the project rules.

### Unlock toast (`src/components/achievements/UnlockToast.tsx`)

- A renderer hook subscribes to `useStatsStore` and diffs `summary.badges` keys against the previous snapshot. The first snapshot after load is only a baseline, so the backlog never replays.
- Each new id is queued, and so is each track that just became complete.
- Rendered bottom-center as a pill: a medal ringed in the tier color, "ACHIEVEMENT UNLOCKED" (or "TRACK COMPLETE"), the name (or title), and the tier label. Timing follows board 6b: medal pops at 0 ms, the pill unrolls by 250 ms, text fades in by 450 ms, and it collapses at 5 s.
- One toast at a time; the queue plays in order. Clicking opens the trophy room on that badge's track. Reduced motion drops the animation and keeps the 5 s hold.
- No sound in this ADR. Notification rows stay as they are.

### Out of scope

- **Feats tab (retired badges):** no badge has been retired yet, so it would always be empty. Add it with the first retirement.
- **Backlog badges that need new counters** (Double Tap, Purge, …): a separate ADR.
- Avatar and display name in the header.

## Consequences

- Finishing a track now earns a title, not just a "Complete" label.
- Secret badges hide only on screen. The definition still ships in the bundle, so anyone reading the code can find them, which is fine for a local toy.
- Adding platinum and secret flags means touching both badge copies again; the existing sync tests catch drift.
- The palette's stats view gets a two-pane layout. At narrow palette widths the sidebar has to wrap above the list, so the CSS must handle that.
- Moving the stats tiles behind a tab hides them from people who opened the view for numbers. The Stats tab is one click away.

## Revision (2026-10-09)

The first build shipped seal (all non-gild badges) and gild (the hardest 1–2 gold badges, after the seal) as two completion layers. Review found two overlapping progress systems with jargon names too confusing, so it was replaced by a single rule: complete every badge in a track to earn its title. Commit: `refactor(adr-212): replace seal and gild with track completion`.

### Revision 2 (2026-10-09)

Nine tracks was too many, and their names (Carnage, Voice, Machinery, …) read as filler. They were folded into four manor-themed tracks with no badge ids or earning rules changed: **Staff** (Command + Carnage, title "Master of the House"), **Orders** (Voice + Reflexes + Machinery, "The Voice"), **Grounds** (Groundskeeping + Shipping, "Groundskeeper") and **Tenure** (Devotion, "Old Guard"). The platinum badge and its track are now **Lord of the Manor**. Starter titles (Greenhorn, Tinkerer, Wrangler, Night Shift) are always available. The header leads with the GitHub login from `gh auth status` and shows the title small underneath. Commits: `787163fa`, `d8c07e7f`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
