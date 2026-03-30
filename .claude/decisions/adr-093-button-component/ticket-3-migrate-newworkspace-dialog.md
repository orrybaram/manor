---
title: Migrate NewWorkspaceDialog buttons to Button component
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate NewWorkspaceDialog buttons to Button component

Replace the submit/cancel/close buttons in NewWorkspaceDialog with the Button component.

## Migration pattern

1. Import `Button` from `@/components/ui/Button/Button`
2. Replace `<button className={styles.cancelButton}>` with `<Button variant="secondary">`
3. Replace `<button className={styles.submitButton}>` with `<Button variant="primary">` (keep disabled logic)
4. Replace `<button className={styles.closeButton}>` with `<Button variant="ghost" size="sm">` (keep the X icon child)
5. Remove orphaned CSS classes from the module file

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` — replace buttons
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css` — remove `.submitButton`, `.cancelButton`, `.closeButton` classes
