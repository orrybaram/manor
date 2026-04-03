---
title: Migrate WelcomeEmptyState flex classes to Row/Stack
status: done
priority: medium
assignee: haiku
blocked_by: [1]
---

# Migrate WelcomeEmptyState flex classes to Row/Stack

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.container` | `Stack` | `align="center" justify="center" gap="2xl"` — keep className for height/width/padding |
| `.title` | `Row` | `align="center" gap="sm"` — keep className for text styling |

## Files to touch
- `src/components/sidebar/WelcomeEmptyState/WelcomeEmptyState.tsx` — swap divs for Stack/Row
- `src/components/sidebar/WelcomeEmptyState/WelcomeEmptyState.module.css` — strip flex properties
