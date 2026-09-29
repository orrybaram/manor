---
title: Scope filtering, chip, and widening in the palette
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Scope filtering, chip, and widening in the palette

Implement the Decision section of ADR-200 (`docs/decisions/adr-200-palette-search-scope/index.md`)
in the palette. Read it first; the mockup is at
https://claude.ai/artifact/D3xZq4Tw9NFVTNQgAdFnhh (option A, chip in input).

1. **Scope state** in `CommandPalette.tsx`: on open (in the existing
   ref-guarded `open && !prevOpenRef.current` block), compute
   `resolvePaletteScope(...)` from ticket 1 using `origin`, `activeSurface`
   (app store), `activeWorkspacePath`, `projects`. Store
   `scopeProjectId` and `openedScopeProjectId` (the resolved value, used for
   Tab toggling back). Reset both in `handleClose`. Also add `scopeArmed`.
2. **Filtering**:
   - Workspace categories: when scoped, keep only the scoped project's group.
     `useWorkspaceCommands` groups by `project.name`; add the project id to
     each category (or filter on items' `id` prefix `ws-${project.id}-` /
     `new-ws-${project.id}`) — don't filter by name, names can collide.
   - `useAgentCommands`: accept `scopeProjectId: string | null`. When set,
     keep only agents with `agent.projectId === scopeProjectId`. When null,
     give each agent row a project tag via `suffix` (small pill, reuse
     `.editorBadge`-like styling; add a `.projectTag` class).
   - Linear/GitHub drill-ins: when scoped, one row each for the scoped
     project (as today). When global, one row per project that has a tracker
     (`linearAssociations` non-empty for Linear; `ghRepoOf(project)` non-null
     for GitHub), labelled `${project.name} Tasks`. Replace the
     `activeProject`-derived `repo` / `allTeamIds` with a
     `trackerProjectId` state set by the drill-in action; default it to the
     scoped project or the old `activeProject` fallback so `initialView`
     deep links keep working.
   - Everything else (go-to, app commands, Run, Project Settings) unchanged.
3. **ScopeChip** — new `src/components/command-palette/ScopeChip.tsx` +
   `ScopeChip.module.css`. Props: `projectName: string | null`, `armed`,
   `onClear`. Scoped: accent-tinted chip (`color-mix(in srgb, var(--accent)
   15%, transparent)` bg, 35% border, `var(--accent)` text), project name,
   and a × using `Button` from `src/components/ui/Button/Button` (check its
   variants; icon/ghost size) with `aria-label="Search all projects"`.
   Armed: stronger bg. Global: neutral chip "All projects", border
   `var(--border)`, `var(--text-primary)` text, no ×. Follow
   `.claude/rules/ui-components.md`.
4. **Input row**: on the root view only, wrap `Command.Input` in a row with
   the chip before it. Move the input's bottom border/padding to the row so
   the chip sits inline (keep the 14px/16px feel of `.input`). Placeholder
   `Search ${name}…` scoped, `Search all projects…` global. Other views keep
   today's input untouched.
5. **Keyboard** (onKeyDown on `Command.Input`, root view only):
   Backspace with empty `search` while scoped → arm, second → widen;
   Tab → toggle between `openedScopeProjectId` and `null` if
   `openedScopeProjectId` is non-null (preventDefault); ⌘↵/Ctrl+↵ → widen
   (preventDefault so cmdk doesn't select). Any other key disarms.
6. **Widening hints**: memo a count of project-owned items outside the scope
   that match `search` (`wordPrefixFilter(itemValue(heading, cmd), search) >
   0`) — the out-of-scope workspace groups and agents. Build those lists from
   the same hook output before filtering. Then:
   - Custom empty content when scoped and count > 0: "No matches in
     **{name}**." / "{N} matches in other projects · ⌫ or ⌘↵ to search
     everywhere". Otherwise keep the ghost empty state.
   - A footer (new `.footer` in `CommandPalette.module.css`, 11px,
     `var(--text-dim)`, top border `var(--surface)`, `kbd`-style hints) on the
     root view: `⌫ clear scope` while scoped; `+N in other projects ⌘↵`
     right-aligned when scoped, search non-empty, results non-empty and
     N > 0. Keep the palette's max-height working (list scrolls, footer
     fixed).
7. Keep `uniqueItemValue`/Frequently Used logic intact; Frequently Used is
   derived from `categories` so it follows scope for free — verify.

Run `pnpm typecheck` (or the repo's equivalent in package.json) and the
existing unit tests for the palette area before committing.

## Files to touch
- `src/components/command-palette/CommandPalette.tsx` — scope state, filtering, input row, keyboard, empty state, footer
- `src/components/command-palette/CommandPalette.module.css` — input row, footer, project tag, scoped empty state
- `src/components/command-palette/ScopeChip.tsx` — new
- `src/components/command-palette/ScopeChip.module.css` — new
- `src/components/command-palette/useAgentCommands.tsx` — scope filter, project tag
- `src/components/command-palette/useWorkspaceCommands.tsx` — expose project id per group
