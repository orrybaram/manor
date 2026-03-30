---
title: Add Pick Element button to BrowserPane toolbar
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add Pick Element button to BrowserPane toolbar

Add a crosshair/target icon button to the BrowserPane toolbar that activates the element picker.

### UI behavior
- Add button after the reload button, using `Crosshair` icon from lucide-react
- When clicked, send IPC `webview:start-picker` to main process
- Button shows active/highlighted state while picker is running
- When picker completes or cancels, reset button state
- Store picked element result in app state per pane

### IPC flow
- Renderer → main: `webview:start-picker(paneId)` — triggers picker injection
- Main → renderer: `webview:picker-result(paneId, result)` — returns captured metadata
- Main → renderer: `webview:picker-cancel(paneId)` — picker was cancelled

### App state
- Add `pickedElement?: PickedElementResult` to pane leaf node data
- Add `setPickedElement(paneId, result)` and `clearPickedElement(paneId)` actions
- Clear picked element on navigation (`did-navigate` event)

## Files to touch
- `src/components/BrowserPane.tsx` — add picker button, IPC calls, active state
- `src/components/BrowserPane.module.css` — styles for active picker button
- `src/store/app-store.ts` — add pickedElement state and actions
- `electron/main.ts` — add `webview:start-picker` IPC handler
- `electron/preload.ts` — expose picker IPC bridge
