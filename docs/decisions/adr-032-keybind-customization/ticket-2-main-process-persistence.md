---
title: Add KeybindingsManager and IPC handlers in main process
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Add KeybindingsManager and IPC handlers in main process

## Files touched
- `electron/keybindings.ts` — new file
- `electron/main.ts` — instantiate + IPC handlers
- `electron/preload.ts` — keybindings namespace
- `src/electron.d.ts` — type definitions
