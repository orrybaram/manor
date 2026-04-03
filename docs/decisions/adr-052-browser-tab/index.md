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

# ADR-052: Browser Tab — In-App Webview for Ports

## Context

Manor detects running dev server ports and shows them in the sidebar. Currently, clicking a port badge opens the URL in the system's default browser via `shell.openExternal()`. Users want the option to preview ports directly inside Manor as an in-app browser tab, similar to how VS Code's Simple Browser works. This avoids context-switching away from the terminal.

The app currently has no webview/browser capability at all — panes are exclusively terminal panes. The `PaneNode` type has no concept of pane variants.

## Decision

### Approach: Webview-based browser pane with extended PaneNode type

1. **Extend `PaneNode` to support browser leaves.** Add a `contentType` discriminator to leaf nodes:
   - `{ type: "leaf", paneId: string }` — terminal (default, backward-compatible)
   - `{ type: "leaf", paneId: string, contentType: "browser", url: string }` — browser

2. **Enable Electron's `<webview>` tag.** Set `webviewTag: true` in webPreferences. The webview runs in a separate renderer process with its own security context, so this doesn't weaken the main window's CSP or sandbox.

3. **Create a `BrowserPane` component.** Renders a `<webview>` tag pointing at the stored URL. Includes:
   - URL bar (editable, shows current URL, navigate on Enter)
   - Back/forward/reload controls
   - A title bar matching the terminal pane status bar style

4. **Update `LeafPane` to dispatch on `contentType`.** If the leaf has `contentType: "browser"`, render `BrowserPane` instead of `TerminalPane`.

5. **Add `addBrowserSession(url)` to the app store.** Creates a new session with a single browser leaf pane.

6. **Update `PortBadge` to offer both options.** Change the port badge click behavior:
   - Left-click opens in a new in-app browser tab (new default)
   - Context menu (right-click) offers "Open in Browser Tab" and "Open in Default Browser"

7. **Add command palette action.** "Open Port in Browser" command that lists active ports and opens the selected one in an in-app browser tab.

### Security considerations
- `<webview>` runs in a separate process — no access to Node.js or the main renderer
- Only localhost URLs from detected ports are opened by default
- CSP on the main renderer is unchanged — the webview has its own security context

## Consequences

**Better:**
- Users can preview dev servers without leaving Manor
- Ports UI becomes more useful — one-click preview
- Opens the door for future browser-based panes (docs, PRs, etc.)

**Harder:**
- `webviewTag` is deprecated in Electron docs in favor of `BrowserView`/`iframe` — but `<webview>` is still the simplest approach for sandboxed content in the renderer and is widely used. Can migrate later if needed.
- Layout persistence needs to handle `contentType` + `url` fields on leaves
- Slightly more complex pane tree model

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
