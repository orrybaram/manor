---
title: Web paste paths in the terminal with toasts
status: done
priority: critical
assignee: opus
blocked_by: [3]
---

# Web paste paths in the terminal

Implements the wiring half of D3, and D5's comment, in ADR-239. Branch on `isWebApp()` (`src/lib/platform.ts`), never on `isRemotePane`: on the web, `isRemotePane` is true for every pane.

## `src/lib/remote-image-paste.ts`
Add `export async function pasteImageFile(term: Terminal, paneId: string, blob: Blob): Promise<void>`:
1. Get the host label from the existing `hostLabel(paneRemoteHost(...))`, falling back to "the host".
2. When `blob.size > PASTED_IMAGE_CHUNK_BYTES`, add a toast: `{ id: \`paste-image-${paneId}\`, message: \`Uploading image to ${host}…\`, status: "loading" }`. Check `src/store/toast-store.ts` for the exact API.
3. Call `uploadPastedImage`, remove the toast, then `term.paste(path + " ")`.
4. On error, add a toast with the same id: `message: \`Couldn't paste image to ${host}\``, `status: "error"`, `detail: err.message`.

Update the module header: the module now has a desktop half (the native clipboard) and a web half (the file from the paste event).

## `src/hooks/useTerminalLifecycle.ts` (onDomPaste, around line 271)
Restructure it as `if (isWebApp()) { … } else if (isRemotePane(paneId)) { existing }`.
- **Web branch:** take the first `items[i]` whose type starts with `image/` and whose `getAsFile()` is not null. Require that there is no `text/plain`. Then `preventDefault()`, `stopPropagation()`, and `void pasteImageFile(t, paneId, file)`.
- Update the comment: on the web, Ctrl+V also arrives here.

## `src/hooks/useTerminalHotkeys.ts` (Ctrl+V branch, around lines 48–66)
Before the `isRemotePane` check, on `isWebApp()`, return `false` for every event type and call nothing.

Add a comment: xterm must not write `\x16`. Not calling `preventDefault` lets the browser paste into xterm's textarea, which fires the DOM `paste` event handled in `useTerminalLifecycle`.

Desktop behaviour stays as it is.

## `src/components/workspace-panes/TerminalPane/TerminalPane.tsx` (Paste in the context menu, around lines 182–195)
On `isWebApp()` with a `term`:
1. Try `navigator.clipboard.read?.()`.
2. If an item has an `image/*` type, call `item.getType(type)` and pass the blob to `pasteImageFile(term, paneId, blob)`.
3. Otherwise (no image, the API missing, or the call rejected), call `readClipboardText()`.

Leave the desktop branch unchanged.

## `src/bridge/unavailable.ts` (comment only, around lines 147–154)
On `terminal.pasteClipboardImage`, say that the web pastes through `pasteImage.*` (ADR-239), and that this entry only keeps the desktop's native method answered for the surface check.

## Tests
- In `src/lib/__tests__/remote-image-paste.test.ts`, add `pasteImageFile` cases, mocking `../paste-image-upload`:
  - success pastes `path + " "`;
  - the loading toast appears only above one chunk and is removed on success;
  - an error toast carries the host label and detail.
- Add a test for the hotkey's web branch if `src/hooks/__tests__/` has hotkey tests. Otherwise ticket 6's e2e covers it; say so in your report.

## Files to touch
- `src/lib/remote-image-paste.ts`
- `src/lib/__tests__/remote-image-paste.test.ts`
- `src/hooks/useTerminalLifecycle.ts`
- `src/hooks/useTerminalHotkeys.ts`
- `src/components/workspace-panes/TerminalPane/TerminalPane.tsx`
- `src/bridge/unavailable.ts` (comment only)
