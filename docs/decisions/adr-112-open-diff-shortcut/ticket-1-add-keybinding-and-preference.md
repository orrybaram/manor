---
title: Add keybinding definition and preference type
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add keybinding definition and preference type

Register the new keybinding and preference so the rest of the feature can wire them up.

## Tasks

### 1. Add keybinding to DEFAULT_KEYBINDINGS

In `src/lib/keybindings.ts`, add a new entry to the `DEFAULT_KEYBINDINGS` array (after the existing `"copy-branch"` entry around line 199):

```typescript
{
  id: "open-diff",
  label: "Open Diff",
  defaultCombo: metaCombo("g", true), // Cmd+Shift+G
  category: "workspace",
},
```

### 2. Add `diffOpensInNewPanel` to AppPreferences

In `src/electron.d.ts`, add to the `AppPreferences` interface (line ~7):

```typescript
diffOpensInNewPanel: boolean;
```

### 3. Add default value in preferences store

In `src/store/preferences-store.ts`, add to `defaultPreferences` (line ~13):

```typescript
diffOpensInNewPanel: true,
```

## Files to touch
- `src/lib/keybindings.ts` — add keybinding definition
- `src/electron.d.ts` — add `diffOpensInNewPanel` to `AppPreferences`
- `src/store/preferences-store.ts` — add default value
