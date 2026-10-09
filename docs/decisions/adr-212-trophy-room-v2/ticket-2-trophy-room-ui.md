---
title: Trophy Room v2 screen
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# Trophy Room v2 screen

Rebuild the stats view as the Trophy Room in ADR-212 ("Trophy Room v2"). The visual reference is the `V2Room` board on the design canvas, rendered in Manor's own theme tokens rather than the canvas's hard-coded hexes. Use the CSS variables that `CommandPalette.module.css` already uses.

## Structure
New folder `src/components/command-palette/trophy-room/`:
- `TrophyRoom.tsx`: the header plus the tabs (Badges | Stats). `StatsView.tsx` now renders `<TrophyRoom>`. Keep the existing streak line, HeroTiles, ContributionGraph and stat table, moved into a `StatsTab` component.
- `TrophyHeader.tsx`
  - Left: the displayed title, which is `preferences.achievementTitle` if it is still in `earnedTitles(summary)`, otherwise the latest earned. If nothing is earned, show "No title yet · seal a track". Add a gold seal icon plus "· gilded" when gilded, and a pencil `Button` (aria-label "Change title") that opens a menu of earned titles. Picking one sets the preference.
  - Right: `earned / total`, a 6px bar segmented by tier, and a tally row from `tierTally`.
- `BadgesTab.tsx`: two panes using flex-wrap, so the sidebar sits above the list in a narrow palette.
  - `TrackSidebar`: Summary, then each section with `n/m`, "sealed" (purple accent) or "gilded" (gold). The selected item is highlighted. Use real buttons, keyboard accessible.
  - `TrackPane`
    - Seal card: "<TRACK> · <blurb>", "Seal it to earn the title <title>" (or "Sealed · <title>"), a seal bar, and a gild line.
    - Rows for the non-gild badges. Each row has a medal, name, tier, description, a progress bar on locked badges with progress, the unlock date on earned ones, and a Reveal button on unrevealed secrets. Reveal appends to `preferences.revealedBadges`.
    - A "GILDING · UNLOCKS AFTER THE SEAL" divider, then the gild rows. Before the seal they are dimmed with a padlock medal; earned ones show normally.
    - Order: earned first by date, then locked by progress ratio.
  - `SummaryPane`: "Next up", the closest locked non-secret badge in each unsealed track (top 3 overall, as cards with progress), then "Recent unlocks" (last 5).
- Medals: the emoji icon when earned (keep the `--badge-color` glow), a dashed ring plus a dimmed emoji when locked, and `?` for an unrevealed secret.
- Selected tab and track live in component state. Expose a way to open on a given track (a prop, or a small zustand field in the stats store such as `focusTrack`), which ticket 3 uses.
- New `TrophyRoom.module.css`. Delete the now-dead `.achievement*` rules from `CommandPalette.module.css`, and delete the old `Achievements` / `AchievementSection` / `AchievementCard` code.
- Follow `.claude/rules/ui-components.md`: `Button` and `Tooltip` from `src/components/ui/`.
- Respect `prefers-reduced-motion` for any transitions.

## Files to touch
- `src/components/command-palette/StatsView.tsx`
- `src/components/command-palette/trophy-room/*` (new)
- `src/components/command-palette/CommandPalette.module.css`
- `src/store/stats-store.ts` (optional `focusTrack`)

## Notes from ticket 1
- `BadgeSectionMeta.name` is the track's display name; `BadgeSectionMeta.title` is the reward title.
- Gild: massacre, extinction (carnage); hive-mind, legion (command); novelist, marathon (voice); devoted, year-round (devotion); forester, scorched-earth (groundskeeping); armada (shipping). Secret: cold-blooded, red-ink, works-on-my-machine.
- New `meta` section holds only `platinum`.
