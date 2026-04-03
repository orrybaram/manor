---
title: Add category field to KeybindingDef
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add category field to KeybindingDef

Add a `category` field to the `KeybindingDef` interface and assign categories to all keybindings in `DEFAULT_KEYBINDINGS`.

Export a `KeybindingCategory` type with values `"app" | "workspace" | "terminal"`.

Category assignments:
- **App**: `settings`, `command-palette`, `toggle-sidebar`, `zoom-in`, `zoom-out`, `zoom-reset`
- **Workspace**: `new-session`, `close-session`, `next-session`, `prev-session`, `select-session-1` through `select-session-9`, `new-task`
- **Terminal**: `split-h`, `split-v`, `close-pane`, `next-pane`, `prev-pane`

Also export a `CATEGORY_LABELS` map: `{ app: "App", workspace: "Workspace", terminal: "Terminal" }` and a `CATEGORY_ORDER` array for display order: `["app", "workspace", "terminal"]`.

## Files to touch
- `src/lib/keybindings.ts` — add `category` to `KeybindingDef`, assign to all entries, export helpers
