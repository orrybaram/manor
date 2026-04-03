---
title: Create BrowserPane component
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Create BrowserPane component

Build the in-app browser pane that renders a `<webview>` tag.

## Changes

### 1. Enable webview tag in Electron (`electron/main.ts`)

In the `createWindow()` function, add `webviewTag: true` to the `webPreferences` object:

```typescript
webPreferences: {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: true,  // <-- add this
},
```

### 2. Create `BrowserPane` component (`src/components/BrowserPane.tsx`)

A component that renders an Electron `<webview>` with navigation controls. Structure:

```
┌──────────────────────────────────────┐
│ [←] [→] [↻]  [ URL bar          ]   │  ← toolbar
├──────────────────────────────────────┤
│                                      │
│           <webview>                  │
│                                      │
└──────────────────────────────────────┘
```

**Props:**
```typescript
{ paneId: string; initialUrl: string }
```

**Behavior:**
- `<webview>` with `src={initialUrl}`, `autosize="on"`, fills container
- URL bar: text input showing current URL, updates on navigation, pressing Enter navigates
- Back button: calls `webviewRef.current.goBack()` (disabled if `!canGoBack()`)
- Forward button: calls `webviewRef.current.goForward()` (disabled if `!canGoForward()`)
- Reload button: calls `webviewRef.current.reload()`
- Listen to webview events: `did-navigate`, `did-navigate-in-page` to update URL bar
- Listen to `page-title-updated` and update pane title in the store via `useAppStore.getState().setPaneTitle?` or directly setting `paneTitle[paneId]`

**Styling:**
- Create `BrowserPane.module.css`
- Toolbar should match the look of the terminal pane status bar (same height, colors, font)
- Use existing theme CSS variables for colors
- Webview fills remaining space with `flex: 1`

**Webview type declarations:**
- Electron's `<webview>` is not a standard HTML element. Add type declarations in a `src/webview.d.ts` file:

```typescript
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        autosize?: string;
        allowpopups?: string;
      },
      HTMLElement
    >;
  }
}
```

### 3. Update `LeafPane` to dispatch on contentType (`src/components/LeafPane.tsx`)

Read the `contentType` from the pane node. If `contentType === "browser"`, render `<BrowserPane>` instead of `<TerminalPane>`.

Need to access the pane node from the store. Add a selector to get the pane node for a given paneId. The leaf pane already receives `paneId` — look up the node from the current session's `rootNode` tree.

**Approach:** Add a `paneContentType` and `paneUrl` record to the app store (similar to `paneCwd` / `paneTitle`), populated when creating a browser pane. This avoids needing to traverse the pane tree in the component.

In `app-store.ts`, add:
```typescript
paneContentType: Record<string, "terminal" | "browser">;
paneUrl: Record<string, string>;
```

Initialize these in `addBrowserSession`. The `LeafPane` component reads `paneContentType[paneId]` and conditionally renders `BrowserPane` or `TerminalPane`.

## Files to touch
- `electron/main.ts` — enable `webviewTag: true` in BrowserWindow webPreferences
- `src/components/BrowserPane.tsx` — new component (webview + toolbar)
- `src/components/BrowserPane.module.css` — new styles
- `src/webview.d.ts` — new type declarations for `<webview>` JSX element
- `src/components/LeafPane.tsx` — dispatch on contentType
- `src/store/app-store.ts` — add `paneContentType` and `paneUrl` records
