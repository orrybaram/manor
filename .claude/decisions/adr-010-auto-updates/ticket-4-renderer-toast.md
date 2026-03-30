---
title: Add update-available toast in renderer
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Add update-available toast in renderer

Use the existing toast system to notify the user when an update has been downloaded and is ready to install.

## Requirements

1. Look at the existing toast system (check the Toast component and app store for how toasts are created) to understand the pattern
2. Add an effect (likely in App.tsx or a dedicated hook) that:
   - Listens to `window.electronAPI.updater.onUpdateDownloaded`
   - When fired, shows a toast with message like "Update v{version} ready — restart to apply. Your sessions will be preserved." and an action button "Restart" that calls `window.electronAPI.updater.quitAndInstall()`
3. The toast should be persistent (not auto-dismiss) since the user needs to choose when to restart
4. Clean up listeners on unmount

## Files to touch
- `src/App.tsx` or a new `src/hooks/useAutoUpdate.ts` — listener + toast trigger
- May need to check/extend `src/components/Toast.tsx` if the toast system doesn't support action buttons or persistent toasts
