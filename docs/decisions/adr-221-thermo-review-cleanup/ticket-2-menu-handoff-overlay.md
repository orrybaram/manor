---
title: Menu handoff as an overlay on the stored view
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Menu handoff as an overlay on the stored view

Bug: `startMenuHandoff` (`src/components/phone/ChatPane/usePaneChatView.ts:73-80`) calls `setPaneChatView(paneId, "terminal")`, persisting `"terminal"` to localStorage via `writeChatView`, while `handoffs` lives in memory. Reload mid-handoff → pane stuck on terminal, no key bar. `endMenuHandoff(paneId, { returnToChat })` exists only to undo that write.

The end paths are scattered: `ChatPane.tsx` (~87-93, `checkHandoff` reading `getState()`), `LeafPane.tsx` (~131-143, `seenTranscript` ref + `useEffect`, untested), `PhoneOverflowMenu.tsx` (~137-139), LeafPane `backToChat`.

Do:
1. New `src/components/phone/ChatPane/menu-handoff.ts`: the `MenuHandoff` type `{ name, startedAt, transcript }` and the pure `endsMenuHandoff` predicate (move from where it lives; `chat-entries.ts` must stop importing types from the zustand store module).
2. Handoff never writes the stored view. The effective view hook returns `handoff ? "terminal" : storedView`. `startMenuHandoff(paneId, name, transcript)` records the current transcript id/path (the same way `markChatStarting` stores `leaving`).
3. A new transcript ending the handoff is derived — e.g. `usePaneMenuHandoff(paneId, transcript)` or ending it in the store call that receives the new transcript — so the LeafPane ref + `useEffect` go away.
4. One `endMenuHandoff(paneId)` with no options. PhoneOverflowMenu's view flip during a handoff and LeafPane's back-to-chat both just end the handoff (which reveals chat). If a user explicitly picks terminal from the overflow menu with no handoff, that still writes the stored view as before.
5. One store call `noteChatEntries(paneId, entries)` that ChatPane calls; ChatPane stops importing the predicate and calling `getState()`.
6. Tests: update `src/components/phone/ChatPane/__tests__/ChatPane.test.ts` and store tests; add a test that a handoff never touches the persisted view (simulate reload: fresh store reads `"chat"`), and that a new transcript ends the handoff. Keep `tests/e2e/phone-chat.spec.ts` passing semantically (update selectors only if needed; do NOT run Playwright).

## Files to touch
- `src/components/phone/ChatPane/usePaneChatView.ts`
- `src/components/phone/ChatPane/menu-handoff.ts` (new)
- `src/components/phone/ChatPane/chat-entries.ts`
- `src/components/phone/ChatPane/ChatPane.tsx`
- `src/components/phone/ChatPane/ChatComposer.tsx` (only the `startMenuHandoff` call signature)
- `src/components/workspace-panes/LeafPane.tsx`
- `src/components/phone/PhoneOverflowMenu.tsx`
- `src/components/phone/ChatPane/__tests__/*`
