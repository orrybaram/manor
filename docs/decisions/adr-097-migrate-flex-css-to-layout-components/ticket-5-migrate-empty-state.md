---
title: Migrate EmptyState flex classes to Row/Stack
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate EmptyState flex classes to Row/Stack

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.container` | `Row` | `align="center" justify="center"` — keep className for height/width |
| `.content` | `Stack` | `gap="3xl"` — keep className for width/align-items |
| `.actions` | `Stack` | `gap="xs"` — keep className for width |
| `.actionKeys` | `Row` | `gap="xs"` |
| `.ticketsSection` | `Stack` | `gap="2xs"` — keep className for width |

## Files to touch
- `src/components/EmptyState.tsx` — swap divs for Row/Stack
- `src/components/EmptyState.module.css` — strip flex properties
