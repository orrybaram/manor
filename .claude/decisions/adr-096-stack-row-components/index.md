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

# ADR-096: Stack and Row layout utility components

## Context

The codebase uses CSS modules for all styling. Flex layout patterns (`display: flex; align-items: center; gap: Xpx`) are repeated extensively across modules. Global CSS utility classes would conflict with the CSS modules approach, so layout primitives should be React components instead.

The user wants a minimal spacing/layout system — just `Stack` (vertical) and `Row` (horizontal) with t-shirt size gaps, plus `align` and `justify` props. No polymorphic `as`, no `Spacer`, no replacement of existing code yet.

## Decision

Create two components in `src/components/ui/Layout/`:

**Gap scale (t-shirt sizes):**
- `xs` → 4px
- `sm` → 8px
- `md` → 12px
- `lg` → 16px
- `xl` → 24px
- `2xl` → 32px
- `3xl` → 48px

**Components:**

- **`Stack`** — `flex-direction: column` with `gap`, `align`, `justify` props
- **`Row`** — `flex-direction: row` with `gap`, `align`, `justify` props

Both accept `children` and `className` for composition with CSS modules. Both render a `<div>`.

Props use inline styles for gap (mapped from t-shirt size), align-items, and justify-content. No CSS module needed for the layout logic itself — the mapping is trivial and inline styles avoid class explosion.

**Prop types:**
```ts
type GapSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

interface LayoutProps {
  gap?: GapSize;
  align?: React.CSSProperties["alignItems"];
  justify?: React.CSSProperties["justifyContent"];
  className?: string;
  children: React.ReactNode;
}
```

Export both from `src/components/ui/Layout/Layout.tsx`.

## Consequences

- **Better**: Common flex patterns become declarative (`<Row gap="md" align="center">` vs writing CSS)
- **Better**: Gap scale creates consistency without needing global CSS vars
- **Neutral**: Inline styles for layout props — acceptable since these are dynamic by nature and there's no complex styling
- **Risk**: Team could over-use these for complex layouts where a CSS module would be clearer — but that's a code review concern, not an architecture one
- **Not doing**: No replacement of existing flex patterns yet — these are additive only

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
