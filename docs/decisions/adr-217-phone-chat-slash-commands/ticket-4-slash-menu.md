---
title: Slash-command menu in the phone chat composer
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# Slash-command menu in the phone chat composer

ADR-217 D5. Ticket 2 provides `window.electronAPI.chat.getCommands(paneId)` and `isInteractiveCommand` in `electron/chat-mirror/builtin-commands.ts`.

## Pure matcher
New `src/components/phone/ChatPane/slash-commands.ts`:
- `findSlashQuery(text: string, caret: number): { query: string } | null`. Returns non-null only when `text` starts with `/`, the caret is > 0 and ≤ the end of the first whitespace-free run, and that run has no whitespace before the caret. The query is `text.slice(1, caret)`.
- `matchCommands(commands, query, limit = 8)`. Case-insensitive ranking:
  1. name prefix
  2. prefix of the part after the last `:`
  3. substring of the name
  4. substring of the description

  Ties stay in alphabetical order. An empty query returns the first `limit` alphabetically, built-ins and skills mixed.
- `applyCommand(text, caret, name): { text, caret }`. Replaces `/query` with `/name ` and puts the caret after the space.
- `firstWordCommand(text): string | null`. Returns the name if the text starts with `/name` followed by whitespace or the end of the text.
- Unit tests next to it (`__tests__/slash-commands.test.ts`, following the repo's test layout for `src/`).

## Hook + menu
- `useSlashCommands(paneId, text, caret)`:
  - Fetches `chat.getCommands` lazily the first time a query appears. Caches the result in the hook and refetches on each open if the cache is older than 30s.
  - Exposes `open`, `items`, `selectedIndex`, `skillsKnown`, `move(delta)`, `pick(index)`, `close()`.
  - On `ok: false` or a rejected fetch, the menu stays closed. Typing still works.
- `SlashCommandMenu.tsx` is a list above the composer field, inside `.composer`, absolutely positioned so it doesn't push the transcript. Each row is a `Button` (`ui/Button/Button`, ghost) with `/name` in monospace, the description on one truncated line, and a small "Opens in terminal" tag when `interactive`. When `skillsKnown` is false, a muted footer reads "Skills appear after your first message." Use `role="listbox"`/`option` and `aria-activedescendant` on the textarea, mirroring what `useEmojiAutocomplete` does.
- `ChatComposer.tsx`:
  - Track the caret (`onSelect`, `onInput`, or read `selectionStart` in `onChange`). Wire the hook.
  - Key handling while open: ArrowUp/ArrowDown move, Enter/Tab pick (preventDefault; ⌘/Ctrl+Enter still sends), Escape closes. Tapping a row picks it and keeps focus in the textarea (preventDefault on pointerdown so the soft keyboard stays up).
  - After picking, set the text and restore the caret with `requestAnimationFrame` + `setSelectionRange`.
  - Make sure `EmojiTextarea`'s popover and this menu can't both be open. Emoji only triggers on `:word`, so in practice they can't, but guard by not opening the slash menu when the emoji popover's `aria-expanded` is true, if that's easy to read.
- On a successful `send()`, if `firstWordCommand(text)` is interactive (`isInteractiveCommand`), call `setPaneChatView(paneId, "terminal")` (from `usePaneChatView.ts`).
- Mobile: the menu must fit 320px wide with a 16px gutter and scroll internally if taller than about 40vh. It works with `KeyboardLift` (`data-keyboard-lift` stays on the composer root).

## Files to touch
- `src/components/phone/ChatPane/slash-commands.ts` — new, pure
- `src/components/phone/ChatPane/__tests__/slash-commands.test.ts` — new (or wherever `src/` unit tests live; check `vitest` config)
- `src/components/phone/ChatPane/useSlashCommands.ts` — new
- `src/components/phone/ChatPane/SlashCommandMenu.tsx` — new
- `src/components/phone/ChatPane/ChatComposer.tsx` — wire menu, keys, interactive → terminal
- `src/components/phone/ChatPane/ChatPane.module.css` — menu styles
