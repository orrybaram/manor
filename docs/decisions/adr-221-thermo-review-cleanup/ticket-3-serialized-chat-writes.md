---
title: Serialize per-pane chat PTY writes
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Serialize per-pane chat PTY writes

`electron/bridge/handlers/chat.ts:54-61` `chatSend` writes `encodeChatMessage(text)`, awaits `SUBMIT_DELAY_MS` (120ms), then writes `CHAT_SUBMIT`. A second `chat.send`, a `chat.key` or `chat.interrupt` landing inside the gap interleaves in the PTY (text A, text B, Enter, Enter).

Do:
1. Add a per-pane serial queue (promise chain keyed by paneId, entry removed when its chain drains) in the chat handler module, or a small `submitPrompt` helper beside `encodeChatMessage`. `chatSend` enqueues "write text → wait → write submit" as one unit; `chatKey` and `chatInterrupt` enqueue their writes too so they never land between text and submit. Keep the 120ms delay (the reason it exists: Enter must arrive separately to submit — commit ffa88e25).
2. `const ESC` in chat.ts duplicates `CHAT_KEYS.esc` — use the map.
3. Move `CHAT_KEYS` (+ its `ChatKey` type) out of `electron/chat-mirror/picker-keys.ts` (documented as picker answers) into `electron/chat-mirror/chat-keys.ts`; keep `CHAT_SUBMIT` with it. Trim `CHAT_KEYS` to keys actually sent (grep `MenuKeyBar.tsx` and callers; `left`, `right`, `space` appear unused — verify before removing). Update `src/electron.d.ts` re-export and imports.
4. Tests in `electron/bridge/handlers/__tests__/chat.test.ts`: two concurrent sends to one pane produce text A, submit, text B, submit in order; a key during a send lands after the submit; sends to different panes don't block each other (use fake timers).

## Files to touch
- `electron/bridge/handlers/chat.ts`
- `electron/chat-mirror/picker-keys.ts`
- `electron/chat-mirror/chat-keys.ts` (new)
- `electron/chat-mirror/__tests__/picker-keys.test.ts`
- `electron/bridge/handlers/__tests__/chat.test.ts`
- `src/electron.d.ts`
- `src/components/phone/ChatPane/MenuKeyBar.tsx` (imports only)
