---
title: Add autocomplete dropdown to URL bar
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add autocomplete dropdown to URL bar

Wire the browser history store into `BrowserPane.tsx` to provide autocomplete suggestions as the user types in the URL bar.

## Behavior

1. On every `onChange` of the URL input, call `useBrowserHistoryStore.getState().search(value)` to get filtered results
2. Show a dropdown below the URL input with up to 8 matching entries
3. Each entry shows the page title (bold) and URL (dimmed) on a single line
4. Keyboard navigation: Arrow Up/Down to highlight, Enter to select, Escape to close
5. Click on an entry to navigate
6. Dropdown closes on: blur (with small delay for click registration), Escape, or selection
7. On navigation (Enter in URL bar or selecting a dropdown item), call `addEntry(url, title)` to record in history. Also call `addEntry` in the `onNavigate` handler so all navigations (including link clicks) are recorded. Use the paneTitle from the store for the title.

## Dropdown styles (BrowserPane.module.css)

- Position: absolute, below toolbar, full width, z-index 100
- Background: `var(--surface)`, border: `1px solid var(--border)`, border-radius: 6px, box-shadow
- Each item: padding 4px 8px, font-size 11px, cursor pointer
- Highlighted item: background `var(--hover)`
- Title: `var(--text)`, URL: `var(--text-dim)`, smaller font

## Files to touch
- `src/components/BrowserPane.tsx` — add autocomplete state, dropdown rendering, keyboard handling
- `src/components/BrowserPane.module.css` — dropdown styles
