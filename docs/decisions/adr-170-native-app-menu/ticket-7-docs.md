---
title: Document the menu and new shortcuts
status: todo
priority: low
assignee: haiku
blocked_by: [5, 6]
---

# Documentation

1. `README.md` › Keyboard Shortcuts › App table: add `Ctrl+Cmd+↓` Next workspace and `Ctrl+Cmd+↑` Previous workspace. Add one sentence above the tables: "Every shortcut also appears next to its item in the menu bar, and Help › Search finds any menu item by name."
2. `CHANGELOG.md`: add an entry under the unreleased/top section describing the new native menu (File / Edit / View / Workspace / Pane / Agents / Window / Help), live shortcut display, Settings in the app menu, Reload removed from packaged builds, zoom applying to the focused window, and the two new shortcuts. Match the existing entry style.
3. Run `pnpm format:check` on the two files (fix with `pnpm prettier --write` if needed).

## Files to touch
- `README.md`
- `CHANGELOG.md`
