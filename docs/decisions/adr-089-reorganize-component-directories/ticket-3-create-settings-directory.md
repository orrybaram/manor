---
title: Create settings/ directory and move settings components
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Create settings/ directory and move settings components

Move settings-related components into `src/components/settings/`.

## Components to move

With subdirectory (has CSS):
- `SettingsModal.tsx` + `SettingsModal.module.css` → `settings/SettingsModal/SettingsModal.tsx` + `SettingsModal.module.css`

Without subdirectory (no CSS):
- `AppSettingsPage.tsx` → `settings/AppSettingsPage.tsx`
- `GitHubIntegrationSection.tsx` → `settings/GitHubIntegrationSection.tsx`
- `IntegrationsPage.tsx` → `settings/IntegrationsPage.tsx`
- `KeybindingsPage.tsx` → `settings/KeybindingsPage.tsx`
- `LinearIntegrationSection.tsx` → `settings/LinearIntegrationSection.tsx`
- `LinearProjectSection.tsx` → `settings/LinearProjectSection.tsx`
- `NotificationsPage.tsx` → `settings/NotificationsPage.tsx`
- `ProjectSettingsPage.tsx` → `settings/ProjectSettingsPage.tsx`
- `ThemeSection.tsx` → `settings/ThemeSection.tsx`

## Files to touch
- `src/components/settings/` — create directory and move files
- All files importing these components — update import paths

## Steps
1. Create `src/components/settings/` and `settings/SettingsModal/`
2. Move each component to its new location
3. Update ALL import paths across the codebase
4. Run `bun run typecheck` to verify
