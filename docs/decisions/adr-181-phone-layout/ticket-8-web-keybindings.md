---
title: A browser does not advertise the chords it cannot have
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# A browser does not advertise the chords it cannot have

ADR-181 D7. Independent of the phone layout — this is a PC-browser fix.

`Cmd+W`, `Cmd+T` and `Cmd+N` (and their Ctrl equivalents off macOS) are the
browser's: it closes the tab, opens one, or opens a window before the page
sees the key. Manor's defaults bind `close-tab`, `new-tab` and `new-agent` to
them, so in the web app the keybindings page and the palette show shortcuts
that do something destructive instead.

- `platformDefaults(platform)` in `src/lib/keybinding-defs.ts` gains a `web`
  variant (the renderer passes `"web"` when `window.electronAPI.platform ===
  "web"`): the three commands keep no default combo there. They stay reachable
  from the palette and the menu. Keep `keybinding-defs.ts`'s ZERO-imports rule
  — main imports it.
- Export the browser-reserved set as data (`BROWSER_RESERVED_COMBOS`) so the
  keybindings page can mark a user override that lands on one as "reserved by
  the browser" rather than letting it look like it works. Overrides are stored
  host-wide, so a desktop user's `Cmd+T` override reaches the browser too —
  marking it is the honest answer; silently dropping it is not.

## Tests
`keybindings` unit tests: the `web` defaults leave the three unbound, every
other default is unchanged, and the reserved-set check flags `Cmd+W`.

## Files to touch
- `src/lib/keybinding-defs.ts`
- wherever the renderer calls `platformDefaults` / `resolveBindings` — pass `"web"` in a browser
- the keybindings settings page — the "reserved by the browser" marker
- `src/lib/__tests__/` — new cases
