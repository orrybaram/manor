---
title: Add Agent Command input to project settings UI
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add Agent Command input to project settings UI

Add a text input for "Agent Command" in `ProjectSettingsPage` so users can configure the CLI command per project.

## Files to touch
- `src/components/ProjectSettingsPage.tsx` — add "Agent Command" field (input, not textarea) in a new "Agent" section. Use the same blur-to-save pattern as other fields. Placeholder: `claude --dangerously-skip-permissions`.
