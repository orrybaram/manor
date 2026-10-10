---
title: Send multi-line chat messages as one prompt
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Send multi-line chat messages as one prompt

`chat.send` writes `text + "\r"`. If Claude Code takes a bare LF as submit, a message containing newlines arrives as several prompts. The spike's `multiline` case (`scripts/spike-picker-keys.mjs multiline`) finds the encoding that arrives as one prompt. The candidates are:
- a raw LF
- a bracketed paste
- backslash + CR

Encode `chat.send` text with the winning candidate. Pin it with a unit test, and record the Claude Code version in `picker-keys.ts`'s header or next to the encoder.

## Files to touch
- `electron/chat-mirror/picker-keys.ts` — e.g. `encodeChatMessage(text)`
- `electron/chat-mirror/mirror.ts` or `electron/bridge/handlers/chat.ts` — wherever `send` builds its bytes
- tests alongside
