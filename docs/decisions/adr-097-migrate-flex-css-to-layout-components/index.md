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

# ADR-097: Migrate simple flex CSS classes to Row/Stack layout components

## Context

ADR-096 introduced `Row` and `Stack` layout components (`src/components/ui/Layout/Layout.tsx`) that provide declarative flex containers with a standardized gap scale. Currently, many CSS modules define simple `display: flex` classes that only set direction, gap, and alignment — exactly what Row/Stack already handle.

An audit of all `*.module.css` files found **~38 classes across 8 files** that are good migration candidates. These classes exist solely to create a flex container and could be replaced by the layout components, reducing CSS surface area and improving consistency.

### Gap scale coverage gap

The current gap scale is: `xs`(4), `sm`(8), `md`(12), `lg`(16), `xl`(24), `2xl`(32), `3xl`(48).

Several CSS classes use gap values not in this scale: **2px**, **6px**, and **28px**. Before migrating those classes, the scale must be extended.

## Decision

1. **Extend the gap scale** in `Layout.tsx` to add missing sizes: `"2xs": 2` and `"xxs": 6`. For the single 28px usage (SettingsModal `.pageContent`), use a className override since it's a one-off value.

2. **Migrate eligible classes** file-by-file. For each class:
   - Replace the `<div className={styles.foo}>` with `<Row>` or `<Stack>` using the appropriate gap/align/justify props
   - If the CSS class has additional non-flex properties (padding, margin, etc.), keep the className on the layout component for those remaining styles and strip only the flex properties from the CSS
   - If the CSS class becomes empty after removing flex properties, delete it entirely

3. **Files to migrate** (grouped by ticket):
   - NewWorkspaceDialog (3 classes)
   - WelcomeEmptyState (2 classes)
   - ProjectSetupWizard (10 classes)
   - EmptyState (5 classes)
   - CommandPalette (6 classes)
   - SettingsModal (11 classes)
   - PaneLayout + TerminalPane (2 classes)

## Consequences

**Better:**
- Less CSS to maintain — ~38 fewer flex declarations
- Consistent gap values via named tokens instead of raw pixel values
- Layout intent is visible in JSX instead of requiring CSS file cross-reference

**Harder:**
- Inline styles from Row/Stack are slightly less inspectable in devtools than class names
- Layout components don't support `flex-wrap`, `overflow`, or other advanced flex properties — those classes correctly remain in CSS

**Risks:**
- Each migration is mechanical but touches both `.tsx` and `.module.css` — care needed to not break styles with additional properties on the same class

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
