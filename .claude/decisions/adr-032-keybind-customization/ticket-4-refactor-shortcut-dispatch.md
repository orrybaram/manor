---
title: Refactor shortcut dispatch to be data-driven
status: done
priority: high
assignee: opus
blocked_by: [1, 3]
---

# Refactor shortcut dispatch to be data-driven

## Files touched
- `src/App.tsx` — data-driven keydown handler
- `src/components/CommandPalette/useCommands.tsx` — dynamic shortcut labels
- `src/hooks/useTerminalHotkeys.ts` — dynamic terminal interception
