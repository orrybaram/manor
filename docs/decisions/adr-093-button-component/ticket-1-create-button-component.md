---
title: Create Button component with variants
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create Button component with variants

Build the shared `Button` component at `src/components/ui/Button/Button.tsx` with its CSS module.

## Requirements

- Follow the existing component pattern: folder with `Button.tsx` + `Button.module.css`
- Props type named `ButtonProps`, parameter named `props`, destructured on first line
- Forward ref to the underlying `<button>` element
- Spread remaining HTML button attributes onto the element
- Default variant: `"secondary"`, default size: `"md"`
- All variants must include hover and disabled states
- Use existing CSS variables from the theme system (`--accent`, `--bg`, `--surface`, `--hover`, `--text-primary`, `--text-dim`, `--text-selected`, `--danger`, `--danger-hover`, `--border`)
- `border-radius: 6px` for all variants except ghost (4px)
- `font-family: inherit` and `cursor: pointer` on all variants
- Disabled state: `opacity: 0.5; cursor: default;` (no pointer events change needed, just visual)
- Do NOT use `useEffect`

### Variant styles

**primary**: `background: var(--accent); color: var(--bg); border: none;` hover: `opacity: 0.9`
**secondary**: `background: transparent; color: var(--text-primary); border: 1px solid var(--surface);` hover: `background: var(--surface)`
**danger**: `background: var(--danger); color: #fff; border: none;` hover: `background: var(--danger-hover)`
**ghost**: `background: transparent; color: var(--text-dim); border: none;` hover: `background: var(--surface); color: var(--text-selected)`
**link**: `background: transparent; color: var(--accent); border: none; padding: 0; text-decoration: underline;` no hover change

### Size styles

**sm**: `padding: 4px 8px; font-size: 12px;`
**md**: `padding: 6px 14px; font-size: 13px;`

Note: link variant ignores size (always padding: 0).

## Files to touch
- `src/components/ui/Button/Button.tsx` — create new
- `src/components/ui/Button/Button.module.css` — create new
