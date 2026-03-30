---
title: Hoist inline callback props in App.tsx
status: done
priority: medium
assignee: haiku
blocked_by: [2]
---

# Hoist inline callback props in App.tsx

The `onNewWorkspace` callback passed to `CommandPalette` is defined inline (lines 173-182), creating a new function reference every render. This defeats `React.memo` if it were applied to `CommandPalette` and causes unnecessary re-renders.

## Implementation

Extract the inline callback to a `useCallback`:

```ts
const handleNewWorkspace = useCallback(
  (opts?: { projectId?: string; name?: string; branch?: string }) => {
    if (opts?.projectId) setPreselectedProjectId(opts.projectId);
    if (opts?.name) setInitialName(opts.name);
    if (opts?.branch) setInitialBranch(opts.branch);
    setNewWorkspaceOpen(true);
  },
  [],
);
```

Then pass it as a prop:
```tsx
<CommandPalette
  open={paletteOpen}
  onClose={closePalette}
  onOpenSettings={() => setSettingsOpen(true)}
  onNewWorkspace={handleNewWorkspace}
/>
```

Also hoist the `onOpenSettings` inline callback:
```ts
const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
```

## Files to touch
- `src/App.tsx` — extract inline callbacks to `useCallback`, pass as stable refs
