---
title: Add notification toggles to App Settings UI
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Add notification toggles to App Settings UI

Add three checkboxes to the existing "Notifications" section in App Settings.

## Implementation details

The committed version of `AppSettingsPage.tsx` already has a "Notifications" `settingsGroup` with the dock badge toggle. Add three more toggles below it:

- "Notify when agent responds" → `notifyOnResponse`
- "Notify when agent needs input" → `notifyOnRequiresInput`
- "Play notification sound" → `notificationSound`

Use the same `toggleRow` pattern as the dock badge toggle. No platform gating needed — these work on both macOS and Linux.

## Files to touch

- `src/components/AppSettingsPage.tsx` — Add three `<label className={styles.toggleRow}>` blocks inside the Notifications `settingsGroup`
