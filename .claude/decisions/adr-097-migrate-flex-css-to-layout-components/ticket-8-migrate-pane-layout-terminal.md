---
title: Migrate PaneLayout and TerminalPane flex classes to Row/Stack
status: done
priority: low
assignee: haiku
blocked_by: [1]
---

# Migrate PaneLayout and TerminalPane flex classes to Row/Stack

| File | CSS class | Component | Props |
|------|-----------|-----------|-------|
| PaneLayout | `.paneStatusActions` | `Row` | `align="center" gap="2xs"` — keep className for flex-shrink |
| TerminalPane | `.errorActions` | `Row` | `gap="sm"` — keep className for margin-top |

## Files to touch
- `src/components/workspace-panes/PaneLayout/PaneLayout.tsx` — swap div for Row
- `src/components/workspace-panes/PaneLayout/PaneLayout.module.css` — strip flex properties from `.paneStatusActions`
- `src/components/workspace-panes/TerminalPane/TerminalPane.tsx` — swap div for Row
- `src/components/workspace-panes/TerminalPane/TerminalPane.module.css` — strip flex properties from `.errorActions`
