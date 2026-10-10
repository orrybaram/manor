---
title: Hook-triggered reads, a poll, and the chat for remote agents
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Hook-triggered reads, a poll, and the chat for remote agents

ADR-216 D3, D4.

1. **Poke and poll.**
   - `ChatMirror.poke(paneId)` reads now if the pane is subscribed. Reads never overlap: a poke during a read sets a "read again" flag.
   - Call it for every hook event whose agent has a pane, from where `captureTranscriptPath` runs (`electron/agent-status/driver.ts`) or the hook relay in `app-lifecycle.ts`, whichever keeps the dependency direction clean.
   - For sources without `watch`, the mirror polls each subscribed pane every 2 seconds and stops on the last unsubscribe.
2. **Unblock remote agents.**
   - `mirror.ts` `resolve()` no longer returns `"remote"`. Keep `"remote"` in the union, but don't produce it.
   - In `src/components/phone/ChatPane/chat-view.ts`, `chatTranscriptPath()` drops its `isRemoteHost` check. Update its tests.
3. **Offline host in the UI.** `ChatPane` handles `"host-offline"`: show "This host is offline. The chat will catch up when it reconnects." with the existing "Show terminal" button. When a later `chat.entry` arrives, or a refetch succeeds, the chat shows again. A simple approach: refetch history when the agent store reports the host back, or on the next entry.
4. **Tests.**
   - Mirror unit tests: poke triggers a read; overlapping pokes coalesce; the poll starts with the first subscriber and stops with the last; `host-offline`.
   - `src/components/phone/__tests__/PhoneTopBar.test.ts` and `chat-view` tests: a remote Claude agent with a transcript gets the chat.

## Files to touch
- `electron/chat-mirror/mirror.ts`, `electron/agent-status/driver.ts` or `electron/app-lifecycle.ts`
- `src/components/phone/ChatPane/chat-view.ts`, `ChatPane.tsx`, tests
