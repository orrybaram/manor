---
title: Migrate dialog buttons to Button component
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Migrate dialog buttons to Button component

Replace all dialog confirm/cancel button patterns with the new `Button` component. These dialogs all share the same `confirmCancel` / `confirmRemove` CSS classes from `Sidebar.module.css`.

## Migration pattern

For each dialog:
1. Import `Button` from `@/components/ui/Button/Button`
2. Replace `<button className={styles.confirmCancel}>` with `<Button variant="secondary">`
3. Replace `<button className={styles.confirmRemove}>` with `<Button variant="danger">`
4. Keep all existing `onClick` handlers and other props
5. Remove unused CSS classes from the module file only if no other component in the same file uses them

## Files to touch

- `src/components/sidebar/DeleteWorktreeDialog.tsx` — replace confirmCancel + confirmRemove buttons
- `src/components/sidebar/MergeWorktreeDialog.tsx` — replace confirmCancel + confirmRemove buttons
- `src/components/sidebar/RemoveProjectDialog.tsx` — replace confirmCancel + confirmRemove buttons
- `src/components/CloseAgentPaneDialog.tsx` — replace confirmCancel + confirmRemove buttons
- `src/components/sidebar/Sidebar/Sidebar.module.css` — remove `.confirmCancel` and `.confirmRemove` classes if no longer referenced after migration (check that no other elements in `Sidebar.tsx` use them)
