---
title: "Phone chat composer: paste an image, insert its path"
status: todo
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Phone chat composer: paste an image

Implements D4 of ADR-239.

`src/components/phone/ChatPane/ChatComposer.tsx`:
- Add an `uploading: boolean` state.
- Add an `onPaste` on the `EmojiTextarea` that acts only when `isWebApp()` and the clipboard holds an `image/*` item with no `text/plain`:
  1. `preventDefault()`, then `setUploading(true)`.
  2. Call `uploadPastedImage(paneId, file)` from `src/lib/paste-image-upload.ts`.
  3. Insert `path + " "` at the caret using the composer's existing `fill`: `fill(text.slice(0, caret) + path + " " + text.slice(caret), caret + path.length + 1)`.
  4. On error, `setError(err.message)`. In a `finally`, `setUploading(false)`.
- While uploading:
  - render "Uploading image…" where the composer's error appears, using a new `composerHint` class in `ChatPane.module.css`, with `data-testid="chat-composer-uploading"`;
  - disable Send.

`chat.send` types its text with no bracketed paste (`electron/chat-mirror/picker-keys.ts`). Claude Code may only treat a path as an image when it is *pasted*. In your report, state that this is unverified for typed paths. Don't change `chat.send`.

## Tests
Use `src/components/phone/ChatPane/__tests__/`, either an existing file or a new `ChatComposer.test.tsx`. Mock `../../../lib/paste-image-upload` and `isWebApp`. Cover:
- an image paste inserts the path at the caret, with a trailing space;
- a text paste is left alone;
- an upload error shows in the error slot.

## Files to touch
- `src/components/phone/ChatPane/ChatComposer.tsx`
- `src/components/phone/ChatPane/ChatPane.module.css`
- `src/components/phone/ChatPane/__tests__/ChatComposer.test.tsx` (new, or an existing test file there)
