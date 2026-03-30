---
title: Group keybindings by category in UI
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Group keybindings by category in UI

Update `KeybindingsPage.tsx` to render keybindings grouped by category with static section headers.

1. Import `CATEGORY_LABELS` and `CATEGORY_ORDER` from `../lib/keybindings`
2. After filtering, group keybindings by category
3. Render each category as a section with a header label, only if it has matching results
4. Add `.keybindingCategory` CSS class to `SettingsModal.module.css` for the header styling

## Files to touch
- `src/components/KeybindingsPage.tsx` — group filtered results by category and render section headers
- `src/components/SettingsModal.module.css` — add `.keybindingCategory` style
