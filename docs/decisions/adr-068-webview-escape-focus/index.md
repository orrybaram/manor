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

# ADR-068: Webview Escape/Unfocus Mechanism

## Context

Once a user clicks into an Electron `<webview>` (browser pane), all keyboard events are captured by the webview's guest content. There is no way to return focus to the Manor UI without using the mouse to click outside. This makes the webview a "focus trap" — particularly frustrating for keyboard-driven users.

The webview is rendered in `BrowserPane.tsx` as a `<webview>` element. It's registered with the main process via `webview:register` IPC which gives us access to the `webContents` object. The main process already attaches a context-menu handler there.

VS Code uses iframes + postMessage for their webviews and relies on F6 for focus navigation. Since we use Electron's `<webview>` tag, we have access to `before-input-event` on the webContents — a simpler and more reliable approach.

## Decision

Implement a double-tap Escape mechanism with visual focus indicator:

### 1. Double-tap Escape via `before-input-event` (main process)

In `electron/main.ts`, inside the `webview:register` handler, attach a `before-input-event` listener on the webview's `webContents`. Track Escape key presses with timing:

- First Escape press: record the timestamp, let it pass through to the page (don't preventDefault)
- Second Escape press within 500ms: call `event.preventDefault()` and send `webview:escape` IPC to the renderer with the `paneId`
- If more than 500ms passes, reset the timer

This preserves in-page Escape functionality (closing modals, etc.) while providing a discoverable escape hatch via double-tap.

### 2. Focus tracking & visual indicator (renderer)

In `BrowserPane.tsx`, listen for `focus` and `blur` events on the `<webview>` element to track whether the webview has focus. Expose this state to `LeafPane` via the existing `onNavStateChange` callback (add a `webviewFocused` field to `BrowserPaneNavState`).

In `LeafPane.tsx`, when the webview is focused:
- Apply a subtle accent-colored top-border on the webview container
- Show a small floating "Esc Esc to exit" hint that fades out after 2 seconds

### 3. Blur on escape (renderer)

In `BrowserPane.tsx`, subscribe to the `webview:escape` IPC channel. When received for this pane, call `.blur()` on the webview element to return keyboard control to Manor.

### Click-outside

Clicking outside the webview already works naturally — clicking any other DOM element takes focus away. No changes needed.

## Consequences

- In-page Escape works normally (single press goes to the page). Only double-tap within 500ms triggers unfocus.
- The visual focus indicator makes it clear when the webview has captured focus.
- The fade-out hint teaches the double-tap mechanism on first use without being persistent/annoying.
- No keybinding forwarding — shortcuts like Cmd+T won't work while the webview is focused. Users must double-tap Escape first, then use shortcuts. This keeps the implementation simple and can be revisited later.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
