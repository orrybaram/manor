---
title: Update LeafPane toolbar UI for new browser features
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Update LeafPane toolbar UI for new browser features

Render loading indicator, favicon, SSL icon, stop button, and find-in-page bar in the browser toolbar.

## Implementation

### 1. `src/components/workspace-panes/LeafPane.tsx`

**Add imports:**
```typescript
import Globe from "lucide-react/dist/esm/icons/globe";
import Lock from "lucide-react/dist/esm/icons/lock";
import Unlock from "lucide-react/dist/esm/icons/unlock";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
```
Note: `X` and `Search` are already imported, `RotateCw` already imported.

**Add find bar state:**
```typescript
const findInputRef = useRef<HTMLInputElement>(null);
```

**Replace the Reload button** (lines 214-222) with a conditional reload/stop:
```tsx
{navState?.isLoading ? (
  <Tooltip label="Stop">
    <button
      className={styles.paneStatusBtn}
      onClick={() => browserRef.current?.stop()}
      title="Stop"
    >
      <X size={12} />
    </button>
  </Tooltip>
) : (
  <Tooltip label="Reload">
    <button
      className={styles.paneStatusBtn}
      onClick={() => browserRef.current?.reload()}
      title="Reload"
    >
      <RotateCw size={12} />
    </button>
  </Tooltip>
)}
```

**Add SSL indicator and favicon** before the URL input (after the reload/stop button, before the `<input>`):
```tsx
{!navState?.isBlank && (
  <>
    {navState?.isSecure ? (
      <Lock size={10} className={styles.paneSecureIcon} />
    ) : (
      <Unlock size={10} className={styles.paneInsecureIcon} />
    )}
    {navState?.favicon ? (
      <img
        src={navState.favicon}
        width={12}
        height={12}
        className={styles.paneFavicon}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    ) : (
      <Globe size={12} className={styles.paneFaviconPlaceholder} />
    )}
  </>
)}
```

**Add find-in-page bar** — render below the status bar, before the autocomplete dropdown. Inside the `contentType === "browser"` branch, after the closing `</div>` of `paneStatusBar` but before the autocomplete dropdown:
```tsx
{contentType === "browser" && navState?.findBarOpen && (
  <div className={browserStyles.findBar}>
    <Search size={12} className={browserStyles.findBarIcon} />
    <input
      ref={findInputRef}
      className={browserStyles.findBarInput}
      value={navState.findQuery}
      onChange={(e) => {
        const q = e.target.value;
        browserRef.current?.findInPage(q);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          browserRef.current?.findInPage(navState.findQuery, {
            forward: !e.shiftKey,
            findNext: true,
          });
        } else if (e.key === "Escape") {
          e.preventDefault();
          browserRef.current?.stopFind();
        }
      }}
      placeholder="Find in page"
      spellCheck={false}
      autoFocus
    />
    {navState.findTotalMatches > 0 && (
      <span className={browserStyles.findBarCount}>
        {navState.findActiveMatch}/{navState.findTotalMatches}
      </span>
    )}
    <button
      className={styles.paneStatusBtn}
      onClick={() => browserRef.current?.findInPage(navState.findQuery, { forward: false, findNext: true })}
      title="Previous match"
    >
      <ChevronUp size={12} />
    </button>
    <button
      className={styles.paneStatusBtn}
      onClick={() => browserRef.current?.findInPage(navState.findQuery, { forward: true, findNext: true })}
      title="Next match"
    >
      <ChevronDown size={12} />
    </button>
    <button
      className={styles.paneStatusBtn}
      onClick={() => browserRef.current?.stopFind()}
      title="Close find"
    >
      <X size={12} />
    </button>
  </div>
)}
```

**Important**: The find bar needs the `findQuery` to be tracked. Update the `handleNavStateChange` callback — it already passes through to `setNavState`, so the find query state from BrowserPane flows through. But BrowserPane's `findInPage` method needs to also update the `findQuery` in nav state. This is handled in ticket-2's `findInPage` ref method — make sure it calls `fireNavStateChange({ findQuery: query })`.

**Focus the find input when it opens**: Use an effect or the `autoFocus` prop (already included above). Also, when the `onFind` IPC event arrives and toggles the find bar open, the autoFocus on the input will handle initial focus.

### 2. `src/components/workspace-panes/BrowserPane/BrowserPane.module.css`

**Add loading bar:**
```css
.loadingBar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
  z-index: 5;
  animation: loadingPulse 1.5s ease-in-out infinite;
}

@keyframes loadingPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

**Add find bar styles:**
```css
.findBar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--dim);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.findBarIcon {
  color: var(--text-dim);
  flex-shrink: 0;
}

.findBarInput {
  flex: 1;
  min-width: 0;
  max-width: 200px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  font-size: 11px;
  color: var(--text);
  outline: none;
  padding: 0 4px;
  font-family: inherit;
}

.findBarInput:focus {
  border-color: var(--accent);
}

.findBarCount {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
```

### 3. `src/components/workspace-panes/PaneLayout/PaneLayout.module.css`

**Add favicon and SSL icon styles:**
```css
.paneFavicon {
  flex-shrink: 0;
  border-radius: 2px;
}

.paneFaviconPlaceholder {
  flex-shrink: 0;
  color: var(--text-dim);
}

.paneSecureIcon {
  flex-shrink: 0;
  color: var(--green);
}

.paneInsecureIcon {
  flex-shrink: 0;
  color: var(--text-dim);
}
```

### 4. `src/components/workspace-panes/BrowserPane/BrowserPane.tsx`

**Add loading bar to the render output** — inside `.webviewContainer`, before the `<webview>`:
```tsx
{navState?.isLoading && <div className={styles.loadingBar} />}
```

Wait — BrowserPane doesn't have access to `navState` as a React state (it uses `navStateRef`). We need a local `isLoading` state. Add:
```typescript
const [isLoading, setIsLoading] = useState(false);
```
And in the `onLoadingChanged` IPC listener, also call `setIsLoading(loading)`.

Then render:
```tsx
<div className={styles.webviewContainer}>
  {isLoading && <div className={styles.loadingBar} />}
  <webview ... />
  ...
</div>
```

**Also update `findInPage` in `useImperativeHandle`** to track the query:
```typescript
findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }) {
  fireNavStateChange({ findQuery: query });
  if (query) {
    window.electronAPI.webview.findInPage(paneId, query, options);
  }
},
```

## Files to touch
- `src/components/workspace-panes/LeafPane.tsx` — Conditional reload/stop, SSL icon, favicon, find bar UI
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — Loading bar render, isLoading local state, findQuery tracking
- `src/components/workspace-panes/BrowserPane/BrowserPane.module.css` — Loading bar and find bar styles
- `src/components/workspace-panes/PaneLayout/PaneLayout.module.css` — Favicon and SSL icon styles
