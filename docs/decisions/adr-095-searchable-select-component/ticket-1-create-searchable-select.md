---
title: Create SearchableSelect UI component
status: done
priority: high
assignee: opus
blocked_by: []
---

# Create SearchableSelect UI component

Build `src/components/ui/SearchableSelect/` with three files: `SearchableSelect.tsx`, `SearchableSelect.module.css`, and `index.ts`.

## Component structure

Use `@radix-ui/react-popover` for the dropdown. The component is controlled (`value` + `onChange`).

**Trigger button**: `Popover.Trigger asChild` wrapping a `<button>` with:
- Optional `icon` prop rendered before the value text
- Value text truncated via CSS (`max-width` from prop, default 250px, `text-overflow: ellipsis`)
- ChevronDown icon on the right
- Styled to match `Button` secondary/sm appearance
- `role="combobox"`, `aria-expanded`, `aria-controls` pointing to the listbox id

**Popover content**: `Popover.Content` with `side="bottom"`, `align="start"`, `sideOffset={4}`:
- Search `<input>` at top, auto-focused via `onOpenAutoFocus`
- Scrollable options list (`max-height: 200px`, `overflow-y: auto`)
- Each option: `role="option"`, `aria-selected` when highlighted
- The list container: `role="listbox"`, `id` matching `aria-controls`
- `aria-activedescendant` on the search input pointing to highlighted option

**Keyboard**:
- ArrowDown/ArrowUp: move highlight (wrap around)
- Enter: select highlighted option, close popover
- Escape: close popover (Radix handles this)
- Typing filters the list

**States**:
- `loading={true}`: show `<Loader2>` spinner + "Loading..." in the list area
- No matches: show `emptyMessage` (default "No results")

**Styling** (CSS module):
- Trigger: `display: inline-flex`, `align-items: center`, `gap: 6px`, `max-width` from prop, secondary button look
- Content: `background: var(--bg)`, `border: 1px solid var(--surface)`, `border-radius: 6px`, `box-shadow: 0 4px 12px rgba(0,0,0,0.3)`, `min-width: 200px`, `z-index: 150`
- Search input: full-width, no border-radius on bottom, `border-bottom: 1px solid var(--surface)`
- Option: `padding: 6px 12px`, `font-size: 13px`, `cursor: pointer`
- Option highlighted: `background: var(--surface)`, `color: var(--text-selected)`
- Spinner animation: reuse the keyframe pattern from existing components

**Index barrel**: `export { SearchableSelect } from "./SearchableSelect";`

## Files to touch
- `src/components/ui/SearchableSelect/SearchableSelect.tsx` — new file, component implementation
- `src/components/ui/SearchableSelect/SearchableSelect.module.css` — new file, styles
- `src/components/ui/SearchableSelect/index.ts` — new file, barrel export
