---
title: Create Input, Textarea, and Select components
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create Input, Textarea, and Select components

Create the shared UI primitives at `src/components/ui/Input/`.

## Files to touch

- `src/components/ui/Input/Input.tsx` — create new: Input, Textarea, Select components
- `src/components/ui/Input/Input.module.css` — create new: all input styling (.input, .ghost, .monospace, .textarea, .select, .selectWrapper, .selectIcon)
- `src/components/ui/Input/index.ts` — create new: barrel export

## Implementation details

### Input.tsx

Three named exports: `Input`, `Textarea`, `Select`.

Follow the existing `Switch` component pattern for prop forwarding (destructure `className` from rest, merge with module styles).

**Input component:**
- Props type: `InputProps` = `{ variant?: "default" | "ghost"; monospace?: boolean } & ComponentPropsWithoutRef<"input">`
- Apply `.input` class by default, `.ghost` when variant is "ghost", `.monospace` when monospace is true
- Forward ref with `React.forwardRef`
- Merge consumer className with internal classes

**Textarea component:**
- Props type: `TextareaProps` = `{ monospace?: boolean } & ComponentPropsWithoutRef<"textarea">`
- Apply `.input` and `.textarea` classes
- Forward ref

**Select component:**
- Props type: `SelectProps` = `ComponentPropsWithoutRef<"select">`
- Wrap in `.selectWrapper` div
- Apply `.select` class to the `<select>` element
- Render a chevron icon (ChevronDown from lucide-react, 14px) in `.selectIcon` span
- Forward ref to the select element

### Input.module.css

Extract the canonical `.fieldInput` styles from `SettingsModal.module.css` as `.input`:

```css
.input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--surface);
  background: var(--bg);
  color: var(--text-selected);
  font-size: 13px;
  border-radius: 6px;
  outline: none;
  font-family: inherit;
}

.input:focus {
  border-color: var(--accent);
}

.input::placeholder {
  color: var(--text-dim);
}
```

Ghost variant:
```css
.ghost {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
}
```

Monospace modifier:
```css
.monospace {
  font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
}
```

Textarea additions:
```css
.textarea {
  resize: vertical;
  line-height: 1.5;
  min-height: 80px;
}
```

Select:
```css
.select {
  /* same base as .input */
  composes: input;
  padding-right: 32px;
  appearance: none;
  cursor: pointer;
}

.selectWrapper {
  position: relative;
}

.selectIcon {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-dim);
  pointer-events: none;
  display: flex;
  align-items: center;
}
```
