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

# ADR-032: Keybind Customization

## Context

Manor had ~20 hardcoded keyboard shortcuts with no way to customize them. Users wanted full keybind customization with its own dedicated settings page.

## Decision

Implemented a full keybind customization system:
- **Data model**: `KeyCombo` type with `key`, `meta`, `ctrl`, `shift`, `alt` fields
- **Default registry**: `src/lib/keybindings.ts` with all 24 commands
- **Persistence**: Separate `keybindings.json` file storing only overrides
- **IPC bridge**: `keybindings:getAll/set/reset/resetAll` + live change events
- **Zustand store**: Merges defaults + overrides, reactive
- **Data-driven dispatch**: Replaced hardcoded if/else in App.tsx
- **Settings UI**: Dedicated page with search, key recorder, conflict blocking, per-binding and global reset
- **Cross-platform**: Cmd on macOS, Ctrl on other platforms

## Consequences

All shortcuts are customizable. Dispatch is data-driven. Terminal hotkey interception is dynamic. No Electron menu accelerator sync (renderer-only for now).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
