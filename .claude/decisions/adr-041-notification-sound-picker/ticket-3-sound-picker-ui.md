---
title: Add sound picker dropdown to Notifications settings page
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Add sound picker dropdown to Notifications settings page

Replace the "Play notification sound" toggle with a sound picker that lets users select from macOS system sounds or disable sound entirely.

## Implementation

### `src/components/NotificationsPage.tsx`
Replace the notification sound toggle row with a sound picker:
- A row with label "Notification sound" on the left, and a `<select>` dropdown on the right
- Options: "None" (value `false`) + macOS system sounds: Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink
- When the user selects a sound (not "None"), immediately play a preview via `window.electronAPI.preferences.playSound(name)`
- On change, call `set("notificationSound", selectedValue === "none" ? false : selectedValue)`
- The current value comes from `preferences.notificationSound` — if it's a string, select that option; if `false`, select "None"

### `src/components/SettingsModal.module.css`
Add styles for the sound select dropdown:
- `.soundSelect` — styled `<select>` matching the existing design system (similar to `.fieldInput` but inline in a row)

## Files to touch
- `src/components/NotificationsPage.tsx` — Replace toggle with sound picker
- `src/components/SettingsModal.module.css` — Add sound select styles
