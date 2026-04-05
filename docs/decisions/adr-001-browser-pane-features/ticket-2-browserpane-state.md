---
title: Add BrowserPane state, logic, and keybindings for new features
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add BrowserPane state, logic, and keybindings for new features

Wire up the new IPC events in BrowserPane, add state fields, expose new ref methods, add search engine fallback, and register keybindings.

## Implementation

### 1. `src/components/workspace-panes/BrowserPane/BrowserPane.tsx`

**Extend `BrowserPaneNavState`** — add these fields:
```typescript
export interface BrowserPaneNavState {
  // ...existing fields...
  isLoading: boolean;
  isSecure: boolean;
  favicon: string | null;
  findBarOpen: boolean;
  findQuery: string;
  findActiveMatch: number;
  findTotalMatches: number;
}
```

**Update `navStateRef` initial value** to include the new fields (all false/null/0/empty).

**Extend `BrowserPaneRef`** — add:
```typescript
stop(): void;
findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }): void;
stopFind(): void;
toggleFindBar(): void;
```

**Add `stop()` to `useImperativeHandle`**:
```typescript
stop() {
  window.electronAPI.webview.stop(paneId);
},
```

**Add find methods to `useImperativeHandle`**:
```typescript
findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }) {
  window.electronAPI.webview.findInPage(paneId, query, options);
},
stopFind() {
  window.electronAPI.webview.stopFindInPage(paneId);
  fireNavStateChange({ findBarOpen: false, findQuery: "", findActiveMatch: 0, findTotalMatches: 0 });
},
toggleFindBar() {
  const open = !navStateRef.current.findBarOpen;
  if (!open) {
    window.electronAPI.webview.stopFindInPage(paneId);
    fireNavStateChange({ findBarOpen: false, findQuery: "", findActiveMatch: 0, findTotalMatches: 0 });
  } else {
    fireNavStateChange({ findBarOpen: true });
  }
},
```

**Modify `navigateTo()`** — add search engine fallback. Before the existing protocol check, detect non-URL input:
```typescript
const navigateTo = useCallback((target: string) => {
  const wv = webviewRef.current;
  if (!wv) return;
  let resolved = target.trim();
  if (!/^https?:\/\//i.test(resolved)) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(resolved);
    if (isLocal) {
      resolved = `http://${resolved}`;
    } else if (/^[\w-]+(\.[\w-]+)+/.test(resolved)) {
      // Has dots — treat as a domain (e.g. "github.com", "foo.bar.com/path")
      resolved = `https://${resolved}`;
    } else {
      // No dots, no protocol, not localhost — treat as a search query
      resolved = `https://www.google.com/search?q=${encodeURIComponent(resolved)}`;
    }
  }
  wv.src = resolved;
  setUrl(resolved);
  setSuggestions([]);
  setHighlightIndex(-1);
  fireNavStateChange({ url: resolved, suggestions: [], highlightIndex: -1 });
}, [fireNavStateChange]);
```

**Derive `isSecure` in `onNavigate`** — after setting the URL:
```typescript
const isSecure = newUrl.startsWith("https://");
fireNavStateChange({ url: blank ? "" : newUrl, isBlank: blank, isSecure });
```

**Subscribe to new IPC events in `useMountEffect`**:

```typescript
const unsubLoading = window.electronAPI.webview.onLoadingChanged(
  (loadPaneId: string, loading: boolean) => {
    if (loadPaneId !== paneId) return;
    fireNavStateChange({ isLoading: loading });
  },
);

const unsubFavicon = window.electronAPI.webview.onFaviconUpdated(
  (favPaneId: string, faviconUrl: string) => {
    if (favPaneId !== paneId) return;
    fireNavStateChange({ favicon: faviconUrl });
  },
);

const unsubFindResult = window.electronAPI.webview.onFindResult(
  (findPaneId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => {
    if (findPaneId !== paneId) return;
    fireNavStateChange({ findActiveMatch: result.activeMatchOrdinal, findTotalMatches: result.matches });
  },
);

const unsubFind = window.electronAPI.webview.onFind(
  (findPaneId: string) => {
    if (findPaneId !== paneId) return;
    fireNavStateChange({ findBarOpen: true });
  },
);

const unsubGoBack = window.electronAPI.webview.onGoBack(
  (navPaneId: string) => {
    if (navPaneId !== paneId) return;
    webviewRef.current?.goBack();
  },
);

const unsubGoForward = window.electronAPI.webview.onGoForward(
  (navPaneId: string) => {
    if (navPaneId !== paneId) return;
    webviewRef.current?.goForward();
  },
);
```

**Unsubscribe all** in the cleanup return.

### 2. `src/lib/keybindings.ts`

Add three new keybinding definitions to `DEFAULT_KEYBINDINGS`:
```typescript
{
  id: "browser-back",
  label: "Browser Back",
  defaultCombo: metaCombo("["),
  category: "browser",
},
{
  id: "browser-forward",
  label: "Browser Forward",
  defaultCombo: metaCombo("]"),
  category: "browser",
},
{
  id: "browser-find",
  label: "Find in Page",
  defaultCombo: metaCombo("f"),
  category: "browser",
},
```

**Note**: `Cmd+[` and `Cmd+]` overlap with `prev-pane` and `next-pane`. This is acceptable because the browser category bindings only fire when a browser webview has focus (handled in main process `before-input-event`), while pane navigation fires at the app level. They don't conflict.

## Files to touch
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — Extend nav state, add ref methods, search fallback, IPC subscriptions
- `src/lib/keybindings.ts` — Add browser-back, browser-forward, browser-find keybinding definitions
