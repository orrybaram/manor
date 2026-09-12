# Use UI Components

Always use components from `src/components/ui/` instead of raw HTML elements for interactive UI.

- Buttons: Use `<Button>` from `ui/Button/Button` — never use raw `<button>` for user-facing actions.
- Links to external URLs: Use `<Link>` from `ui/Link/Link` — never `<Button>` + `openExternal`, and never `<a href="#">`. It opens http(s) URLs in the default browser via Electron's window-open handler.
- Tooltips: Use `<Tooltip>` from `ui/Tooltip/Tooltip`.

Check `src/components/ui/` for available components before reaching for native elements.
