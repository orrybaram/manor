---
title: SearchableSelect gains trailing content and a list height
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# SearchableSelect gains trailing content and a list height

ADR-237 D4. The project theme picker will render through `SearchableSelect`
and needs each option to carry a badge and six colour dots after its label,
the trigger to show the selected option's decoration, and a taller list.

Changes to `src/components/ui/SearchableSelect/SearchableSelect.tsx`:

1. `SearchableSelectOption` gains `trailing?: React.ReactNode` — "Shown
   after the label, before the check mark, and on the trigger when
   selected."
2. Props gain `listMaxHeight?: number` (default `200`, today's CSS value
   if the module sets one; check `SearchableSelect.module.css` and keep its
   default). Apply it as `style={{ maxHeight: listMaxHeight }}` on the
   `optionsList` div.
3. The trigger (`triggerContent`) renders, in order: the `icon` prop if
   given, else the selected option's `icon`; the `triggerText`; then the
   selected option's `trailing` wrapped in `<span className={styles.triggerTrailing}>`.
   Compute `selected = options.find((o) => o.value === value)` once
   (replace the `selectedLabel` memo with a `selected` memo).
4. Each option row renders `option.trailing` in
   `<span className={styles.optionTrailing}>` after the label span, before
   the check.

`SearchableSelect.module.css`: add `.optionTrailing` and `.triggerTrailing`
(`display: flex; align-items: center; gap: 6px; flex-shrink: 0;`). The
trigger text should ellipsize before the trailing content shrinks.

Existing callers (`AddProjectDialog`, `NewWorkspaceDialog/HostPicker`,
`HostsPage/StartHostForm`, `ProjectHostSection`, any others `grep` finds)
must not change behaviour: `trailing` is optional and the trigger's icon
only falls back to the option's when no `icon` prop is given.

## Files to touch
- `src/components/ui/SearchableSelect/SearchableSelect.tsx` — new option field, new prop, trigger and row rendering
- `src/components/ui/SearchableSelect/SearchableSelect.module.css` — two new classes

## Acceptance
- `pnpm typecheck` passes.
- `pnpm test:unit` passes.
