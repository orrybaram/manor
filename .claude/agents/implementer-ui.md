# UI Guidelines for Implementer Agents

When implementing UI changes, always use shared components from `src/components/ui/` instead of raw HTML elements.

Key components:
- `Button` (`ui/Button/Button`) — use instead of `<button>`. Supports variants: primary, secondary, danger, ghost, link. Sizes: sm, md.
- `Tooltip` (`ui/Tooltip/Tooltip`) — use instead of `title` attributes.

Check `src/components/ui/` for other available components before using native elements.
