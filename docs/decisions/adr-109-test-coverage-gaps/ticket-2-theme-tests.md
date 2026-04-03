---
title: Add tests for theme.ts
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Add tests for theme.ts

Write `electron/theme.test.ts` covering the Ghostty config parser, theme builder, and ThemeManager class.

## Approach

The module has internal pure functions (`parseGhosttyFile`, `buildTheme`, `loadThemeFromConfig`) that aren't exported but are exercised through the public `ThemeManager` API. Test via the public class methods, mocking `fs` for file reads.

## Test cases

### Ghostty config parsing (via `loadGhosttyTheme`)
- Parses `key = value` lines, ignores comments and blank lines
- Parses `palette = N=color` entries and maps to correct ANSI color slots
- Returns `null` when theme file doesn't exist

### Theme building
- Maps palette indices 0-15 to correct theme keys (black, red, ..., brightWhite)
- Config overrides (`background`, `foreground`, `cursor-color`, `cursor-text`, `selection-background`, `selection-foreground`) apply correctly
- Falls back to DEFAULT_THEME for missing values

### ThemeManager
- `getThemeByName("__default__")` returns the default theme
- `getThemeByName("__ghostty__")` reads Ghostty config
- `getThemeByName("SomeName")` loads that named theme file
- `getTheme()` reads settings.json and delegates to `getThemeByName`
- `getSelectedThemeName()` returns `__ghostty__` when no setting saved
- `setSelectedThemeName()` persists to settings.json
- `hasGhosttyConfig()` returns true/false based on config file existence

## Mocking strategy

Mock `fs` module (`readFileSync`, `existsSync`, `writeFileSync`, `mkdirSync`, `promises.readdir`, `promises.readFile`) with `vi.mock("node:fs", ...)`. Create fake Ghostty config content as strings in the test.

## Files to touch
- `electron/theme.test.ts` — new file
