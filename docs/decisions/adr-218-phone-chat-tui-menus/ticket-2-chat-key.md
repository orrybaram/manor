---
title: chat.key bridge method for navigation keys
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# chat.key bridge method for navigation keys

ADR-218 D3 (the `chat.key` part). Read the ADR first.

- In `electron/bridge/handlers/chat.ts`, add `chatKey(ctx, paneId, key)`. `key` must be one of `"up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "space"`. Validate it: `assertString`, then throw on anything outside the enum. Map it to `\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`, `\r` (reuse `CHAT_SUBMIT` from `picker-keys.ts` if it's Enter), `\x1b`, `\t`, `" "` and write it with `ctx.deps.backend.pty.write`. Check how `picker-keys.ts` already spells arrow keys and reuse its constants if it exports them (export them if not).
- Register it as `key: method(chatKey)` in the `chat` table, next to `send` / `interrupt`, under the existing "keyboard, not audited" comment.
- Export the key union as a type (`ChatKey`) from wherever the other chat types live, so the renderer's `window.electronAPI.chat.key` is typed. Follow how `chat.answer` / `ChatAnswer` reach `src/electron.d.ts` (or are derived from the handler table) and do the same. Check the remote/relay path (ADR-216): if chat methods are allow-listed for remote phones anywhere, add `key` there too.
- Unit test next to the existing chat handler tests (find them with grep for `chatSend` or `chatInterrupt` in `__tests__`). Each key writes its sequence, and an unknown key throws without writing.

## Files to touch
- `electron/bridge/handlers/chat.ts`
- `electron/chat-mirror/picker-keys.ts` — export the arrow and Tab constants if needed
- the chat type exports / `src/electron.d.ts`, as the existing methods do
- any remote allow-list for `chat.*` methods
- the chat handler test file

Note: `pnpm build` enforces ADR-180 D7, so a new `ElectronAPI` method must be listed in `HANDLERS` (or `nativeApi` / `LOCALLY_SERVED` / `SUBSCRIPTIONS`), or the build fails naming it. Find where `chat.send` is registered and mirror it.
