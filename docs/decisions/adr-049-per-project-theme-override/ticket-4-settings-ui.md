---
title: Add theme override selector to project settings
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Add theme override selector to project settings

Add a theme picker to the project settings page so users can set a per-project theme override.

## Files to touch

- `src/components/ProjectSettingsPage.tsx`
  - Add a "Theme Override" section in the General settings group, after the Color picker
  - Show the current override name or "Global theme" if null
  - Add a dropdown/searchable list that shows available themes (reuse the pattern from `ThemeSection.tsx`):
    - "Use global theme" option at the top (sets `themeName` to `null`)
    - "Match Ghostty" option (`__ghostty__`)
    - All Ghostty themes from `window.electronAPI.theme.allColors()`
  - On selection, call `updateProject(project.id, { themeName: selectedName })` and also call `applyProjectTheme(selectedName)` to preview immediately
  - Keep it simpler than the full ThemeSection — a compact dropdown with search and color previews is sufficient

- `src/components/SettingsModal.module.css`
  - Add any needed styles for the compact theme picker (may reuse existing styles)
