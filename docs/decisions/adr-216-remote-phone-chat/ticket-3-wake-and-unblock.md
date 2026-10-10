---
title: Hook-triggered reads, a poll, and the chat for remote agents
status: done
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

## Added after ticket 2: lines too long to read in one go

`RemoteTranscriptSource` caps a read at 4 MiB. A single line longer than that never completes a line within one read, so the offset never advances and the pane's chat stalls for good. A large tool result or a base64 image could do this.

Fix it in the source or the mirror:
- When a read's `data` holds no `\n` and the read was capped, ask the remote for that line's byte length with a second positional-arg script: `tail -c +$(( $2 + 1 )) "$1" | head -n 1 | wc -c`. It streams, so nothing large is buffered.
- Skip the line: advance the offset by that length.
- Emit no entry for it, or a placeholder `tool`/`assistant` entry saying "(entry too large to show)". Pick whichever fits the parser's skip-unknown rule; a silent skip is fine.
- Pin it with a unit test that runs the real script through `localExec` on a file with a line larger than the cap. Make the cap injectable for the test.
