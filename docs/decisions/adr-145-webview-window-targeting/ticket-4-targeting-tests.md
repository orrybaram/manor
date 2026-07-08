---
title: Tests for window/link targeting & popup routing
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 2, 3]
---

# Tests for window/link targeting & popup routing

Cover the targeting matrix so the `_parent`/iframe regressions can't silently
return and the popup routing stays correct.

## Cases to cover

1. **`_blank` link click → new manor tab** (foreground).
2. **cmd/middle-click → background tab** (tab created, selection unchanged).
3. **`window.open(url, '_parent')` / `'_self'` / `'_top'` → navigate in place**,
   NOT a new tab (the bug #1 regression guard).
4. **`window.open` from inside an `<iframe>` → handled** (bug #2 regression guard),
   routed per its disposition.
5. **`window.open(url, name, "width=…,height=…")` → managed child window**, with
   the opener relationship intact (`opener` set, `postMessage` round-trips,
   `closed` flips after `window.close()`).
6. **Child window lifecycle**: closing the originating pane / main window cleans up
   child windows (no orphans).

## Approach

Prefer the existing Playwright smoke suite (see ADR-128
`adr-128-playwright-smoke-suite`) for the end-to-end webview cases; use unit tests
for `addBrowserTab(url, { background })` selection behavior in the store. Match the
project's existing test layout and runners — inspect how current webview/browser
tests are structured before adding new ones, and follow that pattern.

## Files to touch
- Test files under the project's existing test directory (mirror current
  Playwright / unit-test conventions — locate them first).
- No production code changes; if a case is untestable without a small testability
  hook, flag it rather than reworking Tickets 1–3.
