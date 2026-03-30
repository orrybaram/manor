---
title: Add app preferences persistence layer
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add app preferences persistence layer

Create `electron/preferences.ts` — a simple JSON-backed preferences store.

## Implementation

```typescript
interface AppPreferences {
  dockBadgeEnabled: boolean;
}

const DEFAULTS: AppPreferences = {
  dockBadgeEnabled: true,
};
```

- Store at `manorDataDir()/preferences.json`
- `PreferencesManager` class with `get()`, `set(key, value)`, `getAll()` methods
- Synchronous read on construction (like `ProjectManager`)
- Debounced write on set (like `TaskManager`)
- Emit change callback so main process can notify renderer

## IPC handlers (in `electron/main.ts`)

- `preferences:getAll` → returns full preferences object
- `preferences:set` → sets a single key, saves, broadcasts change to renderer via `preferences-changed` channel

## Preload bridge (`electron/preload.ts`)

Add `preferences` namespace:
- `getAll(): Promise<AppPreferences>`
- `set(key: string, value: unknown): Promise<void>`
- `onChange(callback): () => void`

## Type definitions (`src/electron.d.ts`)

Add `AppPreferences` interface and `preferences` section to `ElectronAPI`.

## Files to touch
- `electron/preferences.ts` — new file, PreferencesManager class
- `electron/main.ts` — instantiate PreferencesManager, add IPC handlers
- `electron/preload.ts` — add preferences bridge
- `src/electron.d.ts` — add type definitions
