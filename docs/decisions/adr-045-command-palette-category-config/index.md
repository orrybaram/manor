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

# ADR-045: Render Command Palette Categories from Config Array

## Context

The `CommandPalette.tsx` component renders its root view categories (Tasks, Run, Workspaces, Commands, Linear, GitHub) with inline, repetitive JSX. Each category has its own conditional rendering block, its own item mapping pattern, and slightly different rendering logic (some have chevrons, some have active badges, some have shortcuts). This makes adding or reordering categories tedious and error-prone.

## Decision

Extract the root view rendering into a **config array** of category descriptors. Each entry describes:

- `id` — unique key
- `heading` — the group heading string
- `visible` — boolean (whether to render)
- `items` — the `CommandItem[]` for that category
- `renderItem` — optional custom render function for categories that need special treatment (e.g., workspace items with active badges, integration items with chevrons)

A new `CategoryConfig` type will be defined in `types.ts`. The config array is built with `useMemo` inside `CommandPalette.tsx`, referencing the existing hook outputs (`taskCommands`, `customCommands`, `workspaceGroups`, `commands`) plus the integration items (Linear/GitHub).

The root view JSX collapses to a single `.map()` over the config array, with a default item renderer and support for per-category overrides.

### Integration items (Linear/GitHub)

The Linear and GitHub categories currently use hardcoded `<Command.Item>` elements with chevrons and navigation callbacks. These will be converted to `CommandItem[]` arrays built inline in the config, reusing the existing navigate callbacks. A shared `chevronIcon` element handles the `<ChevronRight>` adornment via the existing `CommandItem.icon` slot — or more precisely, a new optional `suffix` field on `CategoryConfig` items, since the chevron goes on the right side, not the left icon slot.

Actually, simpler: we add an optional `suffix?: ReactNode` to `CommandItem` in `types.ts`. The default renderer checks for it and renders after the label. This avoids a custom renderItem for integrations.

### Workspace groups

Workspace groups are special — they come as a `Map<string, CommandItem[]>` where each entry is its own `<Command.Group>`. The config array will expand these into multiple entries (one per workspace group), each with its own heading.

## Consequences

- **Positive**: Adding/removing/reordering categories becomes a config change, not JSX surgery. Makes it trivial to add future integrations.
- **Positive**: Reduces ~100 lines of repetitive JSX to ~15 lines of generic rendering.
- **Negative**: Slight indirection — to understand what renders, you read the config array instead of the JSX directly.
- **Risk**: None significant — this is a pure refactor with no behavioral changes.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
