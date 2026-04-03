---
title: Add preferences Zustand store and settings UI toggle
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Add preferences Zustand store and settings UI toggle

## Renderer store (`src/store/preferences-store.ts`)

Create a Zustand store:
- State: `preferences: AppPreferences`, `loaded: boolean`
- On creation: call `window.electronAPI.preferences.getAll()` to load initial state
- Subscribe to `window.electronAPI.preferences.onChange()` for live updates
- Action: `set(key, value)` — calls `window.electronAPI.preferences.set(key, value)` and optimistically updates local state

## Settings UI (`src/components/AppSettingsPage.tsx`)

Add a "Notifications" section after the existing Theme section:

```tsx
<div className={styles.settingsGroup}>
  <div className={styles.sectionTitle}>Notifications</div>
  <label className={styles.toggleRow}>
    <input type="checkbox" checked={dockBadgeEnabled} onChange={...} />
    <span>Show dock badge for agent responses</span>
  </label>
</div>
```

Style the toggle row in `SettingsModal.module.css`:
- `.toggleRow` — flex row with gap, align-items center, font-size 13px, color var(--text-primary), cursor pointer

Only show the dock badge toggle on macOS (check `navigator.platform` or a flag from main process).

## Files to touch
- `src/store/preferences-store.ts` — new file
- `src/components/AppSettingsPage.tsx` — add Notifications section with toggle
- `src/components/SettingsModal.module.css` — add toggleRow styles
