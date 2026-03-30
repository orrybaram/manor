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

# ADR-093: Create a shared Button component with variants

## Context

The app has 40+ `<button>` elements spread across components with no shared Button component. Button styles are duplicated across CSS modules — `confirmCancel`, `confirmRemove`, `submitButton`, `cancelButton`, `backButton`, `skipButton`, `closeButton`, `action`, `linearButton`, `addCommandBtn`, and `prPopoverFooterButton` all define overlapping properties (padding, border-radius, font-size, font-family, cursor) independently. This leads to:

- Inconsistent styling (e.g., `border-radius: 4px` in some places, `6px` in others)
- Duplicated CSS across 10+ module files
- No single place to update button styles app-wide
- Easy to miss hover/disabled/focus states when adding new buttons

## Decision

Create a `Button` component at `src/components/ui/Button/Button.tsx` with CSS module `Button.module.css`, following the existing `ui/` folder pattern (e.g., `Switch/Switch.tsx`).

### Variants

Based on the audit, buttons collapse into these distinct visual variants:

| Variant | Use case | Example current class |
|---|---|---|
| **primary** | Main CTA actions (submit, create) | `.submitButton` — accent bg, dark text |
| **secondary** | Cancel, back, skip, outlined actions | `.cancelButton`, `.backButton` — transparent bg, border |
| **danger** | Destructive actions (delete, remove) | `.confirmRemove` — danger bg, white text |
| **ghost** | Subtle icon buttons, sidebar actions | `.action`, `.closeButton` — no bg, dim text |
| **link** | Inline text links styled as buttons | `.link` — no bg, accent color, underline |

### Sizes

| Size | Padding | Font size | Use case |
|---|---|---|---|
| **sm** | `4px 8px` | `12px` | Icon buttons, compact actions |
| **md** (default) | `6px 14px` | `13px` | Dialog buttons, form actions |

### Props API

```tsx
type ButtonProps = {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "link";
  size?: "sm" | "md";
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;
```

### Migration strategy

1. Build the Button component and CSS
2. Migrate dialog buttons first (DeleteWorktreeDialog, MergeWorktreeDialog, RemoveProjectDialog, CloseAgentPaneDialog, NewWorkspaceDialog) — these are the most duplicated
3. Migrate settings/form buttons (SettingsModal, ProjectSetupWizard)
4. Remove orphaned CSS classes from source modules after migration

Each migration file gets its own ticket so changes are reviewable per-component.

## Consequences

**Better:**
- Single source of truth for button styles
- Consistent hover/disabled/focus states everywhere
- New buttons require zero CSS — just pick a variant
- Easier to evolve the design system

**Harder:**
- Migration touches many files (but each is mechanical)
- Some highly specialized buttons (e.g., color picker, tab buttons) won't use this component — they're too context-specific

**Risks:**
- Visual regressions during migration — mitigated by migrating one component at a time with verification

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
