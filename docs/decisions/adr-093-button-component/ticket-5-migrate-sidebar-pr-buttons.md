---
title: Migrate sidebar and PR popover buttons
status: done
priority: low
assignee: haiku
blocked_by: [1]
---

# Migrate sidebar and PR popover buttons

Replace remaining sidebar action buttons and PR popover button with the Button component.

## Migration pattern

1. Replace `<button className={styles.link}>Open a folder</button>` in Sidebar with `<Button variant="link">`
2. Replace `<button className={styles.prPopoverFooterButton}>` in PrPopover with `<Button variant="secondary" size="sm">`
3. Remove orphaned CSS classes

Note: Do NOT migrate `.action` icon buttons in sidebar headers or `.addButton` in TabBar — these are tightly coupled to their layout contexts and don't benefit from the shared component.

## Files to touch
- `src/components/sidebar/Sidebar/Sidebar.tsx` — replace link button
- `src/components/sidebar/Sidebar/Sidebar.module.css` — remove `.link` class if orphaned
- `src/components/sidebar/PrPopover.tsx` — replace footer button
