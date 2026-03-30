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

# ADR-058: Add about:blank empty state page to browser

## Context

When a new browser tab is opened via the command palette or keybinding, it navigates to `about:blank`, which renders as a plain white page. This creates a jarring visual contrast against the dark app theme and provides no useful affordance — the user sees a blank white rectangle and must click the URL bar to start navigating.

## Decision

Add an empty state overlay in `BrowserPane` that displays when the current URL is `about:blank`. The overlay will:

- Match the app's dark theme using existing CSS variables (`--dim`, `--text-dim`, `--text-primary`)
- Show a subtle prompt like "Enter a URL to get started"
- Auto-focus the URL input when the empty state is showing, so the user can immediately start typing
- Render on top of (or instead of) the webview to avoid the white flash

The overlay is purely a React layer — no changes to the webview or Electron main process needed. When the user navigates (presses Enter in the URL bar), the URL changes from `about:blank` and the overlay disappears, revealing the webview content.

## Consequences

- New browser tabs feel integrated with the app theme instead of flashing white
- Users get a clear affordance that they should type a URL
- Minimal code change — one new CSS class and a conditional render in BrowserPane

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
