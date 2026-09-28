---
title: Split linked settings into a group page and nested member pages
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# Split linked settings into a group page and nested member pages

ADR-193 §2. Read the ADR section in full first.

- `SettingsModal.tsx`: add page kind `{ type: "group"; groupId: string }`.
  Nav under Projects: lone projects as today; a group row (group name) opens
  the group page; below it one nested row per member (in `memberIds` order),
  showing a host icon (`Laptop` for local, `Cloud` for remote) + host label
  ("This machine" or the host's label via the host store), opening
  `{ type: "project", projectId }`. Add a deeper nesting class
  (e.g. `navItemNested2`) in `SettingsModal.module.css`. Active state: exact
  page match only (the group row is active only on the group page). Keep
  ↑/↓ nav working (rows are buttons).
- Opening: `initialProjectId` of a grouped project opens its group page,
  unless `initialSection` is `project-host`, `project-worktrees` or
  `project-ports`, which open that member's page.
- `ProjectSettingsPage.tsx`:
  - Export a `GroupSettingsPage({ group, members })`: **Shared** (name, color,
    theme via `ProjectThemeSelector` — writing through the shared/group path
    from ticket 1 — `LinearProjectSection`, `AgentSection`,
    `CommandsSection`), then `ProjectLinksSection`.
  - For a grouped project, `ProjectSettingsPage` renders the member page:
    heading "<group name> on <host>" with `HostLabel`; **Location** (path,
    default branch, Unlink button); `ProjectHostSection`; `WorktreesSection`;
    `PortsSection`. No name/color/theme/agent/commands/Linear.
  - Lone projects: unchanged.
  - Remove `SectionAnchor`/`anchor` suffixing and `MemberSettings`; all
    sections use plain ids.
  - `ProjectThemeSelector` `applyNow`: apply when the currently active
    workspace's project is in the group (or keep simple: always apply).
- `ProjectLinksSection.tsx`: on the group page, list members (host label,
  path, Unlink) plus an "Unlink all" button (`unlinkGroup`), then "Link with".
  Tighten layout so path truncates.
- `settings-search.ts`: `buildSettingsIndex` takes lone projects and groups
  (with members). Shared section ids index to the group page; machine section
  ids (`project-host`, `project-worktrees`, `project-ports`) to each member
  page with page label `"<group> · <host label>"`. Update the call site and
  `settings-search` tests.
- Update any tests under `src/components/settings/**/__tests__` that assumed
  the single stacked group page.

## Files to touch
- `src/components/settings/SettingsModal/SettingsModal.tsx`
- `src/components/settings/SettingsModal/SettingsModal.module.css`
- `src/components/settings/SettingsModal/settings-search.ts` (+ tests)
- `src/components/settings/ProjectSettingsPage.tsx`
- `src/components/settings/ProjectLinksSection.tsx`
