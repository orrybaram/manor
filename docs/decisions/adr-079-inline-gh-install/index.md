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

# ADR-079: Inline GitHub CLI Install from GitHubNudge

## Context

When `gh` CLI isn't installed, users see a nudge banner suggesting they install it with a link to cli.github.com. This requires leaving the app, opening a browser, finding install instructions, and running the command themselves. We can do better by letting users install directly from the nudge.

## Decision

Transform GitHubNudge into an interactive install experience:

1. **"Install Now" button** added to the nudge bar alongside the existing dismiss button
2. **Embedded xterm terminal** slides out below the nudge (same width, ~200px height) when "Install Now" is clicked
3. **Auto-runs `brew install gh`** in the embedded terminal via the existing PTY API (`window.electronAPI.pty`)
4. **On success**: show a checkmark success animation, then auto-refresh GitHub status via `window.electronAPI.github.checkStatus()` and attempt to load issues
5. **On failure**: terminal stays visible so user can see the error output

Implementation approach:
- Use a lightweight xterm instance with `FitAddon` only (no WebGL, search, etc.)
- Create a dedicated PTY session with a unique pane ID (`gh-install-{timestamp}`)
- Send `brew install gh && exit 0\n` to the PTY, listen for exit event
- Apply the current theme from `useThemeStore` so it matches the app
- Pass an `onInstalled` callback from `WorkspaceEmptyState` so the nudge can trigger a re-fetch of GitHub status and issues
- CSS: sliding animation via `max-height` transition on a wrapper div, terminal has rounded corners and matches `.nudge` background

## Consequences

- **Better**: Frictionless install experience, user never leaves the app
- **Better**: Terminal output gives visibility into install progress
- **Risk**: Assumes Homebrew is available (macOS-only app, reasonable assumption). If brew isn't installed, the terminal will show the error naturally
- **Tradeoff**: Adds xterm as a runtime dependency in the empty state path (already bundled, no size impact)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
