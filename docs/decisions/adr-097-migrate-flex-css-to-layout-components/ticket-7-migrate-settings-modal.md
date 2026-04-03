---
title: Migrate SettingsModal flex classes to Row/Stack
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate SettingsModal flex classes to Row/Stack

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.pageContent` | `Stack` | — keep className for gap (28px not in scale, use `style={{ gap: 28 }}` or className) |
| `.settingsGroup` | `Stack` | `gap="xs"` |
| `.toggleRow` | `Row` | `gap="sm" align="center"` — keep className for text styling |
| `.commandRow` | `Row` | `align="center" gap="sm"` — keep className for margin-bottom |
| `.colorPicker` | `Row` | `gap="xxs"` — keep className for padding |
| `.linearConnected` | `Stack` | `gap="sm"` |
| `.linearDisconnected` | `Stack` | `gap="xxs"` |
| `.linearInputRow` | `Row` | `gap="sm"` |
| `.themePreview` | `Row` | `gap="xs"` — keep className for flex-shrink |
| `.keybindingsList` | `Stack` | `gap="lg"` |
| `.keybindingActions` | `Row` | `align="center" gap="xs"` |

Note: `.pageContent` uses 28px gap which isn't in the scale. Keep `gap: 28px` in CSS and just replace the flex-direction/display with Stack.

## Files to touch
- `src/components/settings/SettingsModal/SettingsModal.tsx` — swap divs for Row/Stack (this is a large file, likely has sub-components)
- `src/components/settings/SettingsModal/SettingsModal.module.css` — strip flex properties
