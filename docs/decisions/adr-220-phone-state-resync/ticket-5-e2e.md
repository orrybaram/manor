---
title: Phone E2E for resync and manual refresh
status: done
priority: medium
assignee: sonnet
blocked_by: [2, 3, 4]
---

# Phone E2E for resync and manual refresh

Add tests to `tests/e2e/phone.spec.ts`. Use the existing phone harness and its helpers.

1. **Resync after a drop.**
   - With the phone page connected, force the bridge socket closed. Use whatever hook the harness offers: `page.context().setOffline(true)`, or close the WebSocket via `page.evaluate`.
   - While it is down, change state on the desktop side. Renaming a workspace is a simple choice.
   - Bring the connection back and fire `visibilitychange`, or wait for the reconnect.
   - Expect the phone to show the new name without a reload.
2. **Overflow Refresh.**
   - Open the overflow menu. Expect `overflow-refresh` and `overflow-reload`.
   - Tap Refresh. The page does not reload: check that a `window.__marker` you set beforehand survives.
3. **Reload app.**
   - Tap `overflow-reload`. The page reloads, the marker is gone, and the page is still paired and connected.

Pull-to-refresh is hard to drive reliably in Playwright touch emulation. Try `page.touchscreen` or synthetic `TouchEvent`s on the chat scroller once. If it is flaky, skip it and say so in the commit.

Run the specs as the README in `tests/e2e/` describes. rtk eats Playwright output, so run them through `rtk proxy`.

## Files to touch
- `tests/e2e/phone.spec.ts`
- `tests/e2e/helpers/*` (only if needed)
