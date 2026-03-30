---
title: Add Cmd+Shift+N new-workspace keybinding and handler
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add Cmd+Shift+N new-workspace keybinding and handler

Two changes:

1. In `src/lib/keybindings.ts`, add a new entry to `DEFAULT_KEYBINDINGS` array (before the `select-session` spread):
   ```ts
   {
     id: "new-workspace",
     label: "New Workspace",
     defaultCombo: metaCombo("n", true),
     category: "workspace",
   },
   ```

2. In `src/App.tsx`, add a handler to `handlersRef.current`:
   ```ts
   "new-workspace": () => setNewWorkspaceOpen(true),
   ```

## Files to touch
- `src/lib/keybindings.ts` — add keybinding definition
- `src/App.tsx` — add handler
