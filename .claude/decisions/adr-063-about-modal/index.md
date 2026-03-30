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

# ADR-063: Add About Modal with Manor Logo in Status Bar

## Context

The status bar's right side is currently empty. We want to add a small Manor logo button there that opens an About modal showing the app version and a list of projects that inspired Manor, each linking to their GitHub repo.

## Decision

### 1. Expose app version to renderer
Add `define: { __APP_VERSION__: JSON.stringify(require('./package.json').version) }` to `vite.config.ts` so the version is available at build time without IPC overhead.

### 2. Status bar logo button
Add a clickable `ManorLogo` to the right side of `StatusBar.tsx`. Style it at ~12px, dim by default with a hover effect.

### 3. About modal
Create `AboutModal.tsx` using Radix Dialog following the existing confirm dialog pattern (from `Sidebar.module.css`). The modal will contain:
- The Manor logo (larger, ~48px)
- App name "Manor"
- Version from `__APP_VERSION__`
- A divider
- "Inspired by" section with links to GitHub repos:
  - superset → https://github.com/nichochar/superset
  - supacode → https://github.com/nichochar/supacode
  - react-grab → https://github.com/nichochar/react-grab
  - libghostty → https://github.com/nichochar/libghostty
  - xterm → https://github.com/nichochar/xterm
  - t3code → https://github.com/nichochar/t3code
  - agent deck → https://github.com/nichochar/agent-deck

Note: The GitHub URLs above are placeholders — the actual repos will be looked up during implementation.

Links open in external browser via `window.electronAPI.shell.openExternal()`.

### 4. State management
The `StatusBar` component manages the open/closed state of the About modal locally via `useState`.

## Consequences

- Adds a subtle branding element to the status bar
- Gives users visibility into what version they're running
- Credits the projects that inspired Manor
- No new dependencies — uses existing Radix Dialog and ManorLogo component

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
