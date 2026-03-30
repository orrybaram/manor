---
title: Add commands section to project settings UI
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add commands section to project settings UI

Add a "Commands" section to ProjectSettingsPage where users can add, edit, and remove custom commands.

## Files to touch

- `src/components/ProjectSettingsPage.tsx` — Add a "Commands" settings group. Render a list of existing commands, each with a name input and command input side by side, plus a trash/delete button. Add an "Add Command" button at the bottom. Use `updateProject()` to persist changes on blur. When adding a command, generate a UUID with `crypto.randomUUID()`. When deleting, filter out the command and update. Use the existing `styles.fieldInput` and `styles.settingsGroup` CSS classes. The section should go between "Agent" and "Worktrees" sections.
- `src/components/SettingsModal.module.css` — Add styles for the command row layout (flex row with gap, delete button styling). Keep it minimal — use existing patterns from the file.
