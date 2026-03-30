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

# ADR-098: Add Context Menu to Terminal Pane

## Context

The TerminalPane component currently has no right-click context menu. Users need quick access to clipboard operations (copy/paste), pane splitting, and terminal reset without relying solely on keyboard shortcuts. The codebase already uses `@radix-ui/react-context-menu` extensively (ProjectItem, SessionButton, PortBadge, LinkedIssuesPopover) with consistent styling patterns.

## Decision

Add a Radix context menu to `TerminalPane.tsx` with three groups of actions:

1. **Clipboard**: Copy (from xterm selection), Paste (from system clipboard into PTY)
2. **Split**: Split Right/Left (horizontal, second/first), Split Down/Up (vertical, second/first) — using `splitPaneAt` from app-store
3. **Reset Terminal**: Send `\x1bc` escape sequence to PTY and call `term.reset()` on the xterm instance

Implementation details:
- Wrap the existing container `div` with `ContextMenu.Root` / `ContextMenu.Trigger`
- Use lucide-react icons matching the screenshot (Clipboard, ClipboardPaste, PanelRight, PanelLeft, PanelBottom, PanelTop, RotateCw)
- Add context menu CSS classes to `TerminalPane.module.css` (following the established pattern from TabBar/Sidebar styles)
- Expose `write` from `useTerminalLifecycle` so the component can send paste data and reset sequences
- Use `navigator.clipboard.readText()` for paste (requires secure context, which Electron provides)

## Consequences

- **Better**: Users get standard terminal context menu operations accessible via right-click
- **Better**: Pane splitting is discoverable without knowing keyboard shortcuts
- **Tradeoff**: Context menu intercepts the browser's native right-click, but this is expected behavior for terminal emulators
- **Risk**: `navigator.clipboard.readText()` may require permission in some contexts — the ClipboardAddon already handles Ctrl+V, so this is additive

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
