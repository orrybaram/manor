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

# ADR-034: Group keybindings by category

## Context

The KeybindingsPage currently renders all keybindings as a flat list. As the number of keybindings grows, it becomes harder to scan and find specific shortcuts. Grouping them by functional category improves discoverability.

## Decision

Add a `category` field to `KeybindingDef` in `src/lib/keybindings.ts` with three categories:
- **App** — settings, sidebar, command palette, zoom
- **Workspace** — new tab, close tab, next/prev tab, select tab 1-9, new task
- **Terminal** — split horizontal/vertical, close pane, next/prev pane

Update `KeybindingsPage.tsx` to group the filtered keybindings by category and render static section headers above each group. The search filter continues to work across all categories, only showing categories that have matching results.

Add a `.keybindingCategory` CSS class in `SettingsModal.module.css` for the section headers.

## Consequences

- Better UX for scanning keybindings
- Slightly more complex data model (`category` field required on every `KeybindingDef`)
- Category assignment is a judgment call — may need adjustment as new keybindings are added

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
