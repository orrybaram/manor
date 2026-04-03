---
title: Migrate settings page inputs to shared components
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Migrate settings page inputs to shared components

Replace all raw `<input>`, `<textarea>`, and `<select>` elements in the settings pages with the new shared components.

## Files to touch

- `src/components/settings/SettingsModal/SettingsModal.module.css` — remove `.fieldInput`, `.fieldInput::placeholder`, `.fieldInput:focus`, `.fieldTextarea`, `.fieldSelect`, `.fieldSelect:focus`, `.selectWrapper`, `.selectIcon`, `.themeSearch`, `.keybindingsSearch` (replace composes references with the Input component)
- `src/components/settings/SettingsModal/SettingsModal.tsx` — replace keybindings search `<input>` with `<Input>`
- `src/components/settings/AppSettingsPage.tsx` — replace `<input>` with `<Input>`
- `src/components/settings/LinearIntegrationSection.tsx` — replace password `<input>` with `<Input>`
- `src/components/settings/ProjectSettingsPage.tsx` — replace all `<input>` with `<Input>`, `<textarea>` with `<Textarea>`, theme search with `<Input>`
- `src/components/settings/NotificationsPage.tsx` — replace `<select>` with `<Select>`

## Migration pattern

For each file:
1. Import `{ Input, Textarea, Select }` from `@/components/ui/Input`
2. Replace `<input className={styles.fieldInput} ...>` with `<Input ...>`
3. Replace `<textarea className={`${styles.fieldInput} ${styles.fieldTextarea}`} ...>` with `<Textarea monospace ...>`
4. Replace the select wrapper + `<select className={styles.fieldSelect}>` + icon pattern with `<Select ...>`
5. For search inputs that `composes: fieldInput`, just use `<Input className={styles.themeSearch}>` (keeping only the margin from the composed class)
6. Remove now-unused CSS classes from the module file

Keep the `.themeSearch` and `.keybindingsSearch` classes if they have additional styling beyond what `.fieldInput` provides (like `margin-bottom: 8px`) — just remove the `composes: fieldInput` line.
