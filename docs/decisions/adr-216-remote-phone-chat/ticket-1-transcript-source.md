---
title: Extract a TranscriptSource from the chat mirror
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extract a TranscriptSource from the chat mirror

ADR-216 D1. This is a pure refactor. Behaviour must not change, and the existing `electron/chat-mirror/__tests__/mirror.test.ts` must pass unchanged, except for constructor wiring.

1. Create `electron/chat-mirror/transcript-source.ts` with:
   ```ts
   export type TranscriptRead = { ok: true; size: number; data: string } | { ok: false; error: string };
   export interface TranscriptSource {
     /** The bytes from `offset` to the current end, and the file's size now. A missing file is size 0. */
     read(path: string, offset: number): Promise<TranscriptRead>;
     /** Optional change signal. Absent for sources that are poked or polled instead. */
     watch?(path: string, onChange: () => void): () => void;
   }
   ```
2. Move the `fs` code out of `mirror.ts` into `LocalTranscriptSource`:
   - `fs.promises.open`, `stat`, the chunked read at an offset in `readNow`
   - `fs.watch` with its poll fallback
   - `data` comes back decoded as UTF-8.
3. Keep the offset accounting in the mirror. The mirror advances its offset by the **byte length** (`Buffer.byteLength`) of the complete lines it consumed, keeps back the partial tail as today, and resets when `size < offset`. If the current code counts bytes differently, keep its semantics but express them in these terms, so ticket 2's remote source can plug in.
4. Add `sourceFor(agent): TranscriptSource` to the mirror's deps. For now it always returns the local source. Wire it in `app-lifecycle.ts`/`wireChatMirror`.

## Files to touch
- `electron/chat-mirror/transcript-source.ts` — new
- `electron/chat-mirror/mirror.ts` — use the source
- `electron/chat-mirror/__tests__/mirror.test.ts` — constructor wiring only
- `electron/app-lifecycle.ts` (or wherever `ChatMirror` is constructed)
