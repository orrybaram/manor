---
title: Up next panel, project tiles and shared ports store
status: todo
priority: high
assignee: sonnet
blocked_by: [6]
---

# Up next panel, project tiles and shared ports store

Finish the dashboard from `docs/decisions/adr-198-home-dashboard-studio/mockup.html` (default style).

## Shared ports

`usePortsData` (`src/components/ports/usePortsData.ts`) runs a scanner in component state for the sidebar's `PortsList`. Mounting it a second time would start a second scanner.

- Move the port list into a small zustand store (`src/store/ports-store.ts`) fed by **one** scanner.
- Keep `usePortsData`'s public shape so `PortsList` doesn't change behaviour. The hook reads from the store, and the scanner starts once (ref-counted, or started at app init).
- Check how the scanner restarts on workspace changes, and keep that working.

## `UpNextPanel.tsx` (span 5)

- Data: `useUpNextIssues()`. Show the top 5 (`all.slice(0, 5)` now that ranking includes priority). The header has "Up next", the sub-label "Assigned to you, no workspace yet", and "View all {total} →" opening the `up-next` palette view (`onOpenPaletteView`).
- Row:
  - priority glyph: Linear-style 3 bars filled by priority (High 3 / Medium 2 / Low 1), an orange "!" square for Urgent, and empty bars for none
  - title
  - sub-line: identifier (mono), project chip, and a `ready-for-agent` tag when it has that label
  - "Start agent →" revealed on hover/focus
- Click → `useStartUpNextIssue`.
- States: a loading skeleton of 3 rows; empty → "No assigned issues without a workspace."; source not connected → a line pointing to settings (reuse whatever the old Up next did).

## `ProjectTiles.tsx` (full width)

- Data: `projectTiles(projects, { ports })` from lib.
- Grid `repeat(auto-fill, minmax(230px, 1fr))`. Each tile is a panel containing:
  - a colour swatch, the project name, and host status right-aligned (a dot in green/yellow/red plus a label)
  - a row of blocks, one per workspace, coloured by state: needs-you red, running green, pr-ready green, pr-open accent, idle surface. Each block has a `<Tooltip>` with the workspace name and state.
  - a footer with "{n} workspaces · +A −R" and the first port (mono, teal) or nothing
- Click the tile → select the most urgent workspace in that project. Click a block → select that workspace.

## Files to touch
- `src/store/ports-store.ts` — new
- `src/components/ports/usePortsData.ts` — read from the store
- `src/components/sidebar/HomeDashboard/UpNextPanel.tsx` (+ CSS) — new
- `src/components/sidebar/HomeDashboard/ProjectTiles.tsx` (+ CSS) — new
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` — mount them
