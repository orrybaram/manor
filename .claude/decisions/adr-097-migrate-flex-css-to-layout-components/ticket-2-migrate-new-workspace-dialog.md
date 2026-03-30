---
title: Migrate NewWorkspaceDialog flex classes to Row/Stack
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate NewWorkspaceDialog flex classes to Row/Stack

Replace simple flex CSS classes with Row/Stack components.

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.header` | `Row` | `align="center" justify="space-between"` — keep className for padding + border-bottom |
| `.actions` | `Row` | `justify="space-between" gap="sm"` — keep className for margin-top |
| `.body` | `Stack` | no gap — keep className for padding |

For each class:
1. Import `Row`/`Stack` from `@/components/ui/Layout/Layout`
2. Replace the `<div className={styles.X}>` with the layout component
3. If the CSS class has remaining non-flex properties, keep className on the component and remove only `display: flex`, `flex-direction`, `align-items`, `justify-content`, and `gap` from the CSS
4. If the CSS class becomes empty, delete it and remove the import reference

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` — swap divs for Row/Stack
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css` — strip flex properties from migrated classes
