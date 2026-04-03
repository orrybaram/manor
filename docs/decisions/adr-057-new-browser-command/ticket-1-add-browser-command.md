---
title: Add New Browser Window command to command palette
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add New Browser Window command to command palette

Wire `addBrowserSession` from the app store into the command palette and add a new command entry.

## Files to touch
- `src/components/CommandPalette/CommandPalette.tsx` — Add `const addBrowserSession = useAppStore((s) => s.addBrowserSession)` and pass it to `useCommands`
- `src/components/CommandPalette/useCommands.tsx` — Add `addBrowserSession` to `UseCommandsParams` interface and add a new command entry with id `new-browser`, label `New Browser Window`, calling `addBrowserSession("about:blank")` then `onClose()`
