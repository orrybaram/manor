---
paths:
  - "src/**/*.tsx"
---

# Use UI Components

Use components from `src/components/ui/` instead of raw HTML elements for interactive UI; check there before reaching for a native element.

- Buttons: `<Button>` from `ui/Button/Button`, not a raw `<button>`.
- Links to external URLs: `<Link>` from `ui/Link/Link`, not `<Button>` + `openExternal` or `<a href="#">`. It opens http(s) URLs in the default browser via Electron's window-open handler.
- Tooltips: `<Tooltip>` from `ui/Tooltip/Tooltip`, not a `title` attribute.
- Text inputs holding user-authored names or prose: `<EmojiInput>` / `<EmojiTextarea>` from `ui/EmojiAutocomplete`. Not for search, URLs, paths, code or credentials.
