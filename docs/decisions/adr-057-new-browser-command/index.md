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

# ADR-057: Add Command Palette Command for New Browser Window

## Context

The app supports browser sessions (webview tabs) via `addBrowserSession(url)` in the app store, but this is only accessible through the PortBadge right-click context menu when a port is detected. There's no way to open a blank browser tab from the command palette.

## Decision

Add a "New Browser Window" command to the command palette's core commands in `useCommands.tsx`. The command will open a new browser session with `about:blank` as the default URL, allowing users to navigate from there.

Changes:
1. **`src/components/CommandPalette/CommandPalette.tsx`** — Pull `addBrowserSession` from `useAppStore` and pass it to `useCommands`
2. **`src/components/CommandPalette/useCommands.tsx`** — Accept `addBrowserSession` param and add a "New Browser Window" command entry

## Consequences

- Users can quickly open a browser tab from the command palette without needing a detected port
- Minimal change footprint — only 2 files modified

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
