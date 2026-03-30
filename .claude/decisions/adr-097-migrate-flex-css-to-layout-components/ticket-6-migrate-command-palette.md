---
title: Migrate CommandPalette flex classes to Row/Stack
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate CommandPalette flex classes to Row/Stack

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.command` | `Stack` | — keep className for overflow |
| `.breadcrumb` | `Row` | `align="center" gap="xxs"` — keep className for padding |
| `.sidebarField` | `Stack` | `gap="xs"` |
| `.sidebarValue` | `Row` | `align="center" gap="xxs"` — keep className for text styling |
| `.skeletonRow` | `Row` | `align="center" gap="sm"` — keep className for padding |
| `.keybindingActions` | `Row` | `align="center" gap="xs"` |

## Files to touch
- `src/components/command-palette/CommandPalette.tsx` — swap divs for Row/Stack
- `src/components/command-palette/CommandPalette.module.css` — strip flex properties
