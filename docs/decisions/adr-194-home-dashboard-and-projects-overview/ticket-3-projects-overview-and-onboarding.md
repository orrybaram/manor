---
title: Projects overview cards, add section, and onboarding
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Projects overview cards, add section, and onboarding

ADR-194 §2–§3. Fill in `ProjectsOverview`, then make it the zero-project
onboarding.

## Layout (see prototype, "Projects" view)
- Top-aligned column, max 760px, same fonts and tokens as the Home empty state
  (`src/components/EmptyState.module.css`).
- Header: "Projects" (18px, `--text-selected`) and a dim "N projects · N hosts".
- **Cards grid:** `repeat(auto-fill, minmax(230px, 1fr))`, gap 12px.
  - Card: `var(--hover)` background, radius 8, 1px transparent border that
    turns `var(--border)` on hover. Use `<Button variant="ghost">` with a card
    className, or a clickable container that has proper role/keyboard support.
    Follow `.claude/rules/ui-components.md`.
  - Content comes from `projectCardSummary()` (ticket 1), fed from
    `buildTopLevelEntries(projects)`, agent/app stores and `memberHostName`:
    - name, in the project color via `projectColorStyle` when set
    - host badge
    - mono path
    - counts: needs you (red, only when > 0), workspaces, running, PRs
    - up to 3 pending workspaces with a colored status dot (input/error = red,
      blocked = peach, ready = green, finished = teal), or "Nothing open"
  - Click: `selectProject` plus select its current workspace. For a group,
    use the `lastUsedHostId` member. That flips `activeSurface` back via
    `setActiveWorkspace`.
- **"Add a project"** section: a dim label with a hairline, like the Home
  section headers from ticket 4. Coordinate the shared style by putting it in
  `EmptyState.module.css`.
  - "Open a folder": FolderPlus icon → `onAddLocal`, i.e. App's
    `handleAddLocalProject`. Give it `data-testid="import-project-button"`.
  - "Clone onto a remote host": Server icon → `onAddRemote`, which opens
    `AddProjectDialog` with `initialMode="remote"`.
  - Drop zone: a dashed box, "or drop a folder here". Port the drop logic from
    `WelcomeEmptyState.tsx:30-49` (folder = `type === "" && size === 0`, read
    `File.path`) → `onDropFolder`, i.e. App's `handleDropFolder`.
- **Zero projects:** the ManorLogo (same treatment as Home) above the header,
  with no cards, and the add section as the main content.

## Onboarding consolidation
- `src/App.tsx`: the zero-project branch renders `ProjectsOverview`. Remove
  `WelcomeEmptyState` usage.
- Delete `src/components/sidebar/WelcomeEmptyState/`, and check that knip is
  clean.
- `tests/e2e/fixtures.ts:~294` `importSeededProject`: clicking
  `import-project-button` now opens the directory picker directly. Drop the
  `add-project-dialog` / "Choose Folder…" step and keep whatever mock the
  fixture uses for `dialog.openDirectory`. Read the fixture first.
- `tests/e2e/remote-host.spec.ts:~117`: go through the "Clone onto a remote
  host" row. The dialog then opens on the remote tab, so the "On a remote host"
  click becomes unnecessary; keep it harmless or remove it.

## Files to touch
- `src/components/projects-overview/ProjectsOverview.tsx`
- `src/components/projects-overview/ProjectsOverview.module.css`
- `src/components/projects-overview/ProjectCard.tsx` — new
- `src/components/EmptyState.module.css` — shared section-header style
- `src/App.tsx`
- `src/components/sidebar/WelcomeEmptyState/` — delete
- `tests/e2e/fixtures.ts`
- `tests/e2e/remote-host.spec.ts`
