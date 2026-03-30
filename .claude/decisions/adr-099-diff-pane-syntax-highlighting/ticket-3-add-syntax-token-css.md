---
title: Add Prism token CSS styles
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add Prism token CSS styles

## Tasks

1. Add Prism token class styles to `DiffPane.module.css`. Since we use CSS modules, we need to use `:global()` for Prism's class names (e.g., `.token.keyword`).
2. Map token types to existing CSS variables for theme consistency:
   - `.token.keyword`, `.token.builtin` → `var(--blue)` or similar
   - `.token.string`, `.token.char` → `var(--green)` or a dedicated string color
   - `.token.comment` → `var(--text-dim)`
   - `.token.number`, `.token.boolean` → `var(--yellow)` or similar
   - `.token.function` → `var(--blue)` or similar
   - `.token.operator`, `.token.punctuation` → `var(--text-dim)`
   - `.token.class-name`, `.token.tag` → accent color
3. For `.lineAdd` and `.lineDel` rows, syntax token colors should be muted (use `color-mix()` or reduced opacity) so the diff semantic (red/green) remains dominant.

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.module.css` — add token styles
