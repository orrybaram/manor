---
title: Create Stack and Row layout components
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Create Stack and Row layout components

Create `src/components/ui/Layout/Layout.tsx` with `Stack` and `Row` components.

## Implementation details

**Gap scale map:**
```ts
const gapScale: Record<GapSize, number> = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 32, "3xl": 48,
};
```

**Props type:**
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

**Component pattern:**
- Both components are simple `div` wrappers with inline styles
- Use `React.forwardRef` with named functions (matches Button/Input pattern)
- Set `displayName` on each
- Merge `className` prop onto the div for CSS module composition
- `Stack` sets `flexDirection: "column"`, `Row` sets `flexDirection: "row"`
- Both set `display: "flex"` always
- Map `gap` prop through `gapScale` to pixel value
- Pass `align` → `alignItems`, `justify` → `justifyContent`

**Exports:** Named exports `Stack` and `Row` from the file.

## Files to touch
- `src/components/ui/Layout/Layout.tsx` — create new file with both components
