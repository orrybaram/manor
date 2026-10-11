---
title: Terminal and chat panes resync
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Terminal and chat panes resync

Implement ADR-220 D3.

## Terminal

Each mounted terminal pane re-attaches when `onBridgeResync` fires.

How it works today:
- `useTerminalStream.ts` subscribes to `pty.onOutput` and the other pty events. It holds output in a queue until `openRestored(term, snapshot)` (:67), which writes the snapshot followed by the chunks that arrived after it. Seq dedupe is in `lib/snapshot-dedupe`.
- `closeOutput` (:89) re-arms that queue for a re-attach.
- The snapshot comes from `pty.create` (useTerminalConnection.ts:90), called from useTerminalLifecycle.ts:315-434.
- A remote re-attach path already exists at useTerminalLifecycle.ts:203 (`useRemotePaneStore.consumeReattach`).

What to do:
- Read that re-attach path and reuse it. On resync, a mounted pane should:
  1. re-arm the output queue,
  2. call `create` again for a fresh snapshot,
  3. reset the xterm buffer and write the snapshot plus the queued chunks.
- The result must not show duplicated or missing output.
- Register the resync listener in an effect, and unsubscribe on unmount.
- Guard against a resync firing while a create is already in flight: ignore it, or chain it after the current one.
- The resync signal only fires on web (see `src/bridge/resync.ts`), so desktop behaviour does not change. Do not add platform checks.

## Chat

- `ChatPane.tsx` (:78-148) has an inner `fetchHistory()` inside an effect.
- Register `onBridgeResync(() => fetchHistory())` in the same effect and unsubscribe in its cleanup.
- Entries upsert by id (`chat-entries.ts`), so merging is safe. Check that a resync does not reset scroll-follow state in a jarring way.
- Also re-fetch slash commands in `useSlashCommands.ts:45` on resync, the same way.

## Tests

- Add or extend unit tests where hooks are already tested.
- At minimum, test that the chat resync calls `getHistory` again and merges new entries.
- For terminals, test the re-attach sequence with a fake bridge if the existing tests make that practical. If not, say so in the commit.

## Files to touch
- `src/hooks/useTerminalStream.ts`
- `src/hooks/useTerminalLifecycle.ts`
- `src/hooks/useTerminalConnection.ts` (only if needed)
- `src/components/phone/ChatPane/ChatPane.tsx`
- `src/components/phone/ChatPane/useSlashCommands.ts`
- tests
