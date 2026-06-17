# Manual test harnesses

Interactive HTML fixtures for behavior that can't be driven by the headless
Playwright/vitest harnesses because it requires a live Electron `<webview>` guest
page, real `webContents.setWindowOpenHandler` dispatch, or real `BrowserWindow`
instances.

## window-targeting.html — ADR-145

Covers the window/link targeting matrix from
`docs/decisions/adr-145-webview-window-targeting/`. The automated suite covers the
pure logic (`addBrowserTab` background behavior, `buildPopupWindowOptions`
clamping); this page covers the end-to-end behavior that needs a real webview.

### How to run

1. Build & launch Manor from this branch:
   ```
   npm run dev          # or your usual Manor launch for the link-target-fix branch
   ```
2. Open a **browser tab** in Manor (Cmd+N → browser, or the New Browser command).
3. Paste the absolute `file://` path into the URL bar, e.g.:
   ```
   file:///ABSOLUTE/PATH/TO/repo/tests/manual/window-targeting.html
   ```
4. Click through each section and watch the on-page **Log** plus the Manor tab
   strip / window list.

### Expected results (maps to the ADR matrix)

| Section | Case | Expected |
|---|---|---|
| A: anchor `_blank` | #1 | New **foreground** Manor tab |
| A: cmd/middle-click | #2 | New **background** Manor tab; focus stays on the harness |
| A: anchor `_self`/`_parent`/`_top` | #3 | Navigates **this tab in place** (no new tab); Back returns |
| B: `window.open(url)` / `_blank` | #1 | New Manor tab; handle may be `null` (tab path) |
| B: `window.open(url, '_self'/'_parent'/'_top')` | #3 | Navigates in place, **not** a new tab |
| C: `window.open(url, name, 'width=…')` | #5 | Separate **managed popup window** (not a tab); `popup-loaded` message logged from `window.opener` |
| C: postMessage / close buttons | #5/#6 | opener↔popup `postMessage` round-trips; `popup.closed` flips `true` after close |
| C: close the Manor tab/pane while popup open | #6 | Popup window also closes (parented to main window) |
| D: iframe `window.open` / `_blank` | #4 | **Handled** (tab/popup), not silently dropped |
| D: iframe `window.open(_parent/_top)` | #4 | Navigates **within the harness page's frame tree** — never a Manor tab |
| D: iframe `parent.postMessage` | #4 | Reaches the top document (logged), staying internal |

### Notes
- Navigation targets use self-describing `data:` URLs so the page works offline and
  it's obvious which target fired.
- `_self`/`_top`/`_parent` at the top level intentionally replace the harness — that
  *is* the correct in-place behavior. Use the browser Back button to return.
- If a features-popup logs `window.open returned null`, that's a regression — the
  managed-child-window path (ADR-145 ticket 3) failed to open the window.
