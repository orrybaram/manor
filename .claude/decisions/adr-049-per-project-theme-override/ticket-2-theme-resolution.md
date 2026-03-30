---
title: Add project theme resolution to theme store
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add project theme resolution to theme store

Add the ability for the renderer to apply a project-specific theme and revert to the global theme.

## Files to touch

- `electron/theme.ts`
  - Extract a public `getThemeByName(name: string): Theme` method from `getTheme()` that resolves `__ghostty__` / `__default__` / named themes. Have `getTheme()` call this internally.

- `electron/main.ts`
  - No new IPC handlers needed. The existing `theme:preview` handler already resolves a theme by name and returns a `Theme` object. We'll use that.

- `src/store/theme-store.ts`
  - Export `applyCssVars` so it can be called from outside the store if needed
  - Add `applyProjectTheme(themeName: string | null): Promise<void>` action:
    - If `themeName` is non-null, call `window.electronAPI.theme.preview(themeName)` to get the Theme object, then call `applyCssVars(theme)` and `set({ theme })`
    - If `themeName` is null, call `loadTheme()` to restore the global theme
  - Store a `projectThemeOverride: string | null` in state so we know whether we're currently showing a project theme or the global one
