---
title: Context token count from the chat transcript
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Context token count from the chat transcript

ADR-223 D4. Surface the session's current context size to the phone chat
renderer, reusing the existing `chat.entry` push channel.

## Parser (`electron/chat-mirror/transcript.ts`)

- `TranscriptParser` tracks the newest non-sidechain `assistant` line's
  `message.usage`. Context size =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (each defaulting to 0 when absent/non-numeric; null if `usage` is missing
  entirely or all three are absent). Output tokens excluded.
- Expose `contextTokens(): number | null`.
- Note Claude Code writes one assistant JSONL line per content block, each
  carrying the same message usage — taking the newest is correct.
- Stay defensive: never throw on odd shapes (existing `push` try/catch helps).
- Unit tests in `electron/chat-mirror/__tests__/` alongside the existing
  transcript tests: sums the three fields, newest line wins, sidechain lines
  ignored, missing usage → null.

## ChatEntry + mirror (`electron/chat-mirror/transcript.ts`, `mirror.ts`)

- Add a variant to `ChatEntry`:
  `{ kind: "usage"; id: "usage"; ts: string; contextTokens: number }`.
  The parser does NOT put it in `entries()`.
- `ChatHistory` ok branch gains `contextTokens: number | null`
  (`chat.getHistory`).
- In the mirror's read/poll loop, after feeding new lines, if
  `parser.contextTokens()` changed since last publish (and is non-null),
  `deps.publish(paneId, { kind: "usage", id: "usage", ts: <now ISO>, contextTokens })`.
  Find where the mirror tracks per-pane state (`m.parser`, `m.lastSkills`) and
  keep a `lastContextTokens` there. Add a mirror test if the existing mirror
  tests make that straightforward.
- Check `src/electron.d.ts` / any duplicated `ChatEntry`/`ChatHistory` type on
  the renderer side and keep them in sync. Check `electron/bridge/handlers/chat.ts`
  needs no change (it should forward any entry).

## Renderer (`src/components/phone/ChatPane/`)

- `usePaneChatView.ts`: take `contextTokens` from the history result; when a
  `chat.entry` push has `kind === "usage"`, update a `contextTokens` state and
  do NOT add it to the entry list. Return `contextTokens: number | null` from
  the hook.
- `ChatEntryView.tsx`: make sure an unknown/`usage` kind renders `null`
  (defensive; it should never arrive there).
- `ChatPane.tsx`: pass `contextTokens` to `<ChatComposer>` as a new optional
  prop; `ChatComposer` passes it to `<ChatStatusLine contextTokens={…} />`.
  Ticket 4 renders it — here just plumb the prop (ChatStatusLine may accept
  and ignore it, or ticket 4 adds it; coordinate by adding the prop to
  `ChatStatusLine`'s signature now, unused).

## Files to touch
- `electron/chat-mirror/transcript.ts` — usage tracking, `usage` ChatEntry variant
- `electron/chat-mirror/mirror.ts` — `contextTokens` in history, publish usage entry on change
- `electron/chat-mirror/__tests__/*` — parser (and mirror) tests
- `src/electron.d.ts` — if chat types are mirrored there
- `src/components/phone/ChatPane/usePaneChatView.ts` — split usage out of entries
- `src/components/phone/ChatPane/ChatEntryView.tsx` — ignore unknown kinds
- `src/components/phone/ChatPane/ChatPane.tsx` — pass contextTokens down
- `src/components/phone/ChatPane/ChatComposer.tsx` — accept and forward contextTokens
