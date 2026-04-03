---
title: Add context menu to TerminalPane
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add context menu to TerminalPane

Implement the full context menu for the TerminalPane component with Copy, Paste, Split (Right/Left/Down/Up), and Reset Terminal actions.

## Files to touch
- `src/hooks/useTerminalLifecycle.ts` — expose `write` in return value
- `src/components/workspace-panes/TerminalPane/TerminalPane.tsx` — add context menu
- `src/components/workspace-panes/TerminalPane/TerminalPane.module.css` — add context menu styles
