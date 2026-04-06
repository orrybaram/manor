---
title: Create ProcessesView command palette sub-view
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create ProcessesView command palette sub-view

Build the `ProcessesView` component that renders inside the command palette when the user navigates to the "processes" view.

## Implementation

### 1. Create `src/components/command-palette/ProcessesView.tsx`

Follow the same pattern as `LinearIssuesView.tsx`:
- Fetch data on mount via `window.electronAPI.processes.list()`
- Use `useState` for the process info, load on mount and after any kill action
- Render three `Command.Group` sections:

**"Manor Internal" group:**
- Item: `Terminal Host Daemon — PID {pid}` with status indicator (alive/dead)
  - If alive: kill button on the right (calls `processes.killDaemon()`)
  - If dead: dim/greyed out text
  - Info tooltip (via `<Info size={12} />` icon): "Background process that keeps your terminal sessions alive across app restarts"
- Items for each internal server: `Agent Hook Server — :{port}`, `Webview Server — :{port}`, `Portless Proxy — :{port}`
  - These are informational only (no kill action — they live in the main process)
  - Info tooltips:
    - Agent Hook Server: "Receives lifecycle events from AI agents like Claude Code"
    - Webview Server: "Provides inspection and interaction API for browser panes"
    - Portless Proxy: "Routes .localhost hostnames to your local dev server ports"

**"Sessions" group:**
- One item per session: show `sessionId` (truncated) and `cwd` (basename of path)
- If alive: show green dot, kill action (calls `processes.killSession(sessionId)`)
- If not alive: dim, no kill action
- If no sessions: show "No active sessions"
- Info tooltip on the group heading: "Each terminal pane runs in its own isolated subprocess"

**"Ports" group:**
- One item per listening port: `:{port} — {processName} (PID {pid})`
- Kill action calls `window.electronAPI.ports.killPort(pid)`
- If no ports: show "No listening ports"
- Info tooltip on the group heading: "TCP ports listening on localhost, typically dev servers"

**Info tooltip pattern:**
- Use a small `<Info size={12} />` Lucide icon next to the label/heading, styled dim (`var(--text-dim)`)
- On hover, show a native `title` attribute tooltip (simplest approach, no custom tooltip component needed)
- CSS class `.processInfo` — inline-flex icon with `cursor: help`, dim color, `margin-left: 4px`

**Footer:**
- Render a footer bar (reuse `styles.detailFooter` pattern) with a "Kill All" button
- Style as danger/red using `styles.footerHintDanger`
- Calls `processes.killAll()`, then re-fetches the list

After any kill action, re-fetch the process list to update the UI.

Use Lucide icons: `Activity` for daemon, `Terminal` for sessions, `Globe` for ports, `X` for kill actions, `Info` for tooltips.

### 2. Add CSS styles

Add minimal styles to `CommandPalette.module.css`:
- `.processKill` — a small icon button on the right side of items (similar to `.chevron` positioning but as a clickable button)
- `.processMeta` — right-aligned dim text for PID/port info (similar to `.issueState`)
- `.statusAlive` / `.statusDead` — small colored dot indicators
- `.processInfo` — inline-flex icon button, `cursor: help`, `color: var(--text-dim)`, `margin-left: 4px`, no border/background

### 3. Update types

Add `"processes"` to the `PaletteView` union type in `src/components/command-palette/types.ts`.

### 4. Wire into CommandPalette.tsx

- Add `"processes"` view handling alongside existing `linear-all` and `github-all`:
  - Show breadcrumb with "Processes" label and back button
  - Render `<ProcessesView />` inside `Command.List` when `view === "processes"`
  - Hide the search input for this view (processes are few enough to not need filtering)
- Add a "Processes" command item to the root categories list:
  - Place it in the "Commands" category or as its own category
  - Icon: `Activity` from Lucide
  - Suffix: `<ChevronRight />` (drill-in indicator)
  - Action: `setView("processes")`
  - Keywords: `["process", "port", "kill", "daemon", "terminal", "activity"]`

## Files to touch
- `src/components/command-palette/ProcessesView.tsx` — new file
- `src/components/command-palette/CommandPalette.module.css` — add process-specific styles
- `src/components/command-palette/types.ts` — add "processes" to PaletteView
- `src/components/command-palette/CommandPalette.tsx` — wire the new view and add root command item
