---
title: Migrate sidebar dialog inputs to shared components
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Migrate sidebar dialog inputs to shared components

Replace all raw `<input>`, `<textarea>`, and `<select>` elements in the sidebar dialogs with the new shared components.

## Files to touch

- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` — replace `<input>` elements with `<Input>`, `<select>` wrapper with `<Select>`
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css` — remove `.fieldInput`, `.fieldInput::placeholder`, `.fieldInput:focus`, `.ghostInput`, `.fieldSelect`, `.fieldSelect:focus`, `.selectWrapper`, `.selectIcon`
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx` — replace all `<input>` with `<Input>`, `<textarea>` with `<Textarea>`
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.module.css` — remove `.fieldInput`, `.fieldInput::placeholder`, `.fieldInput:focus`, `.fieldTextarea`

## Migration pattern

Same as ticket-2. Additional notes:

- NewWorkspaceDialog ghost input: use `<Input variant="ghost" monospace />`
- NewWorkspaceDialog combobox input: use `<Input>` for the text field (the dropdown/keyboard logic stays unchanged)
- NewWorkspaceDialog select: use `<Select>` (removes the manual wrapper + chevron icon)
- ProjectSetupWizard textarea: use `<Textarea monospace />`
- The branch combobox input inside NewWorkspaceDialog uses `.fieldInput` — replace with `<Input>`, keep the keyboard event handlers and ref
