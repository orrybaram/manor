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

# ADR-056: Element Picker for Browser Tabs

## Context

When users iterate on a website's UI in Manor's browser pane, they often want to point at a specific element and say "change this." Currently the agent can take screenshots and get DOM snapshots via the `manor-webview` MCP server, but there's no way for the user to visually select an element and have its context automatically fed to the agent.

[react-grab](https://github.com/aidenybai/react-grab) solves a similar problem for React apps by using [bippy](https://github.com/aidenybai/bippy) to traverse React's fiber tree via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, extracting component names, file paths (via `_debugSource`), and HTML markup. However, it has significant limitations:

- **React-only** — no support for Vue, Svelte, plain HTML, etc.
- **Dev-only** — `_debugSource` metadata is stripped from production builds
- **Must load before React** — bippy's hook must be registered before React initializes
- **Relies on private APIs** — fiber tree internals can change between React versions

Manor needs a solution that works for **any website** rendered in a browser pane, not just React dev builds.

## Decision

### Approach: Injected Element Picker Overlay

Build an element picker as a **script injected into the webview** via Electron's `executeJavaScript`. When activated, it overlays the page with hover highlighting and click-to-select behavior — similar to browser DevTools' element inspector.

### Architecture

```
User clicks "Pick Element" button in BrowserPane toolbar
    ↓
BrowserPane sends IPC to main process: webview:start-picker
    ↓
Main process calls wc.executeJavaScript(PICKER_SCRIPT)
    ↓
Picker script runs inside webview:
  - Adds mouseover listener → highlights hovered element with overlay
  - On click → captures element metadata, posts back via console.log
  - Removes itself
    ↓
Main process captures result via console-message listener
    ↓
Result stored in app state, surfaced to agent context
```

### What the Picker Captures (Framework-Agnostic)

For any website, without requiring framework-specific hooks:

1. **HTML snippet** — the selected element's `outerHTML` (truncated to ~2000 chars), plus its parent chain as a breadcrumb (e.g., `body > div.app > main > section.hero > h1`)
2. **Computed styles** — key visual properties: `color`, `background`, `font-size`, `font-family`, `padding`, `margin`, `display`, `position`, `width`, `height`
3. **Bounding box** — position and dimensions relative to the viewport
4. **Accessibility info** — `role`, `aria-label`, `aria-describedby`, tab index
5. **Cropped screenshot** — use `wc.capturePage({ x, y, width, height })` to capture just the selected element's region

### Optional: React Source Enhancement

When the page is a React dev build, attempt to extract richer context:

1. After the user selects a DOM element, check if `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` exists
2. Use `element._reactFiber$*` or `element[Object.keys(element).find(k => k.startsWith('__reactFiber$'))]` to get the fiber node
3. Walk up the fiber tree to extract: component name, `_debugSource` (file, line, column), parent component chain
4. Include this as a `## React Context` section in the output

This is best-effort — if it fails (production build, non-React), we still have the framework-agnostic data.

### Integration Points

**BrowserPane toolbar** (`src/components/BrowserPane.tsx`):
- Add a "Pick Element" button (crosshair icon) to the nav bar
- When active, visual indicator on the button (highlighted state)
- Clicking it sends IPC `webview:start-picker` → main process injects the picker script

**Webview server** (`electron/webview-server.ts`):
- New endpoint: `POST /webview/:id/pick-element` — injects the picker script and waits for the result
- Returns the captured metadata as JSON

**MCP server** (`electron/mcp-webview-server.ts`):
- New tool: `pick_element` — triggers the picker and returns structured context
- New tool: `get_element_context` — given a CSS selector, returns the same metadata without user interaction (useful for agent-driven inspection)

**App state** (`src/store/app-store.ts`):
- Store `pickedElement` per pane — when set, the agent can read it as context
- Clear when user picks a new element or navigates away

### Output Format for Agent Context

```xml
<picked_element pane="pane-abc123">
## Selector Path
body > div.app > main > section.hero > h1.title

## HTML
<h1 class="title" id="hero-title">Welcome to My App</h1>

## Computed Styles
font-size: 48px; color: rgb(17, 24, 39); font-family: Inter, sans-serif;
font-weight: 700; margin: 0 0 16px 0; padding: 0;

## Bounding Box
x: 120, y: 200, width: 640, height: 58

## Accessibility
role: heading, aria-level: 1

## React Context (if available)
Component: HeroSection at src/components/HeroSection.tsx:23:5
Parent chain: App > Layout > HomePage > HeroSection
</picked_element>
```

### Picker Script Design

The injected script should:
- Create a fixed-position overlay `div` with `pointer-events: none` that follows the hovered element's bounding box
- Use `mouseover` on `document` with `pointer-events: auto` temporarily disabled on the overlay
- On click, capture metadata, encode as JSON, `console.log('__MANOR_PICK__:' + json)`
- Clean up: remove overlay, restore any modified styles, remove all event listeners
- Support `Escape` to cancel without selecting
- Use a distinct prefix (`__MANOR_PICK__`) so the console-message listener can distinguish picker results from normal console output

## Consequences

### Benefits
- **Framework-agnostic** — works on any website, not just React dev builds
- **Leverages existing infrastructure** — builds on the webview server, MCP server, and console-message listener already in place
- **Rich context for the agent** — HTML, styles, screenshot, and optional React source location gives the agent everything it needs to make targeted changes
- **Non-intrusive** — injected script cleans up after itself; no permanent page modifications
- **Two interaction modes** — user-initiated (toolbar button) and agent-initiated (`get_element_context` with selector)

### Trade-offs
- **No source mapping for non-React frameworks** — Vue, Svelte, etc. won't get file path context. Could be extended later with framework-specific plugins.
- **Injected scripts can conflict with CSP** — some pages with strict Content-Security-Policy headers may block `executeJavaScript`. Electron webviews generally bypass CSP for injected scripts, but this should be tested.
- **React fiber access is fragile** — the `__reactFiber$` property key includes a random suffix per React instance. This is a best-effort enhancement, not a guaranteed feature.
- **Element picker UX needs polish** — hover highlighting, z-index management, iframe handling, and shadow DOM traversal all need careful implementation.

### Open Questions
- Should the picked element context be automatically injected into the agent's next prompt, or should the agent explicitly request it via MCP?
- Should we support picking elements inside iframes?
- Should the cropped screenshot be taken automatically (adds latency) or only on agent request?
- Could we integrate with source maps (if available) to get file locations for non-React sites?

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
