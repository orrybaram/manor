---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-093: Standardize Input Component

## Context

The app has 30+ raw `<input>`, `<textarea>`, and `<select>` elements scattered across 10+ files. The `.fieldInput` CSS class is copy-pasted identically in 3 separate CSS module files (SettingsModal, ProjectSetupWizard, NewWorkspaceDialog). There are also inconsistencies:

- Padding varies: `8px 12px` (standard), `4px 12px` (ghost), `6px 10px` (commands)
- Font size varies: 13px (standard), 11px (ghost), 14px (command palette)
- No shared `Input` component exists in `src/components/ui/`
- Textarea styling is bolted on via `.fieldTextarea` composing `.fieldInput`
- A custom combobox is hand-rolled in NewWorkspaceDialog with its own keyboard nav
- The `<select>` elements have a custom wrapper pattern for the chevron icon

The existing `ui/` directory already has `Switch`, `Toast`, `Tooltip` — `Input` is the obvious missing primitive.

## Decision

Create a shared `Input` component at `src/components/ui/Input/` with these variants:

### Components

1. **`Input`** — standard text input (replaces all `<input type="text|password">`)
2. **`Textarea`** — multiline input (replaces all `<textarea>`)
3. **`Select`** — styled native select with chevron (replaces all `<select>` + wrapper pattern)

### Props API

```tsx
type InputProps = {
  variant?: "default" | "ghost";  // ghost = transparent bg, no border (branch name display)
  monospace?: boolean;            // for code/path inputs
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">;

type TextareaProps = {
  monospace?: boolean;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

type SelectProps = {
  children: React.ReactNode;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className">;
```

All components accept a `className` override for escape-hatch styling but the base styles are baked in via CSS modules.

### Styling

One shared `Input.module.css` with:
- `.input` — the canonical field style (currently `.fieldInput`, 13px, 8px 12px padding, 6px radius)
- `.ghost` — transparent variant (currently `.ghostInput`)
- `.monospace` — SF Mono font family
- `.textarea` — resize + min-height + line-height additions
- `.select` / `.selectWrapper` / `.selectIcon` — native select with chevron overlay
- Focus state: `border-color: var(--accent)`
- Placeholder: `color: var(--text-dim)`

### Migration

Replace all raw `<input>` elements with `<Input>`, all `<textarea>` with `<Textarea>`, and all `<select>` + wrapper with `<Select>`. Delete the duplicated `.fieldInput` classes from each component's CSS module.

The command palette input (cmdk's `Command.Input`) is left as-is — it's a library component with its own styling needs.

## Consequences

- **Positive**: Single source of truth for input styling. Adding a new form field anywhere is one import, zero CSS. Design changes propagate everywhere.
- **Positive**: Removes ~40 lines of duplicated CSS across 3 files.
- **Negative**: Slight indirection — contributors must know to use `<Input>` not `<input>`.
- **Risk**: The `className` omission might be too restrictive if a consumer needs truly custom styling. Mitigated by keeping the escape hatch.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
