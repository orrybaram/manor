---
title: Transcript mirror service and chat bridge namespace
status: todo
priority: high
assignee: opus
blocked_by: [1, 2, 3]
---

# Transcript mirror service and chat bridge namespace

ADR-215 D4, D5. Read ADR-178's bridge sections, `electron/bridge/types.ts`, `electron/bridge/events.ts` and an existing namespace such as `electron/bridge/handlers/agents.ts` before starting.

## Service

`electron/chat-mirror/mirror.ts`, one mirror per pane:

- Resolve the pane's agent and its `transcriptPath`.
- If the agent's `hostId !== LOCAL_HOST_ID`, return `unavailable: "remote"`.
- Read the file from the start through `TranscriptParser`, then tail it.
  - Use `fs.watch` with a byte-offset read and a poll fallback.
  - Buffer a partial trailing line until its newline arrives.
- When `transcriptPath` changes for that pane (ticket 2 updates it), reset the parser and re-read.
- Watch only while there is at least one subscriber. Release the watcher on the last unsubscribe and when the pane closes.

## Bridge `chat` namespace

Follow the existing handler and registration patterns exactly, including the audit classification next to the `pty.write` comment in `pty.ts`.

- `getHistory(paneId)` → `{ ok: true, entries } | { ok: false, reason: "no-agent" | "no-transcript" | "remote" }`
- event `chat.entry [paneId, entry]`: pane-keyed like `pty.*`. Add it to `BridgeEvents`, add it to `SUBSCRIPTIONS` as `"chat.onEntry": "chat.entry"`, and update `src/bridge/__tests__/resolution.test.ts` expectations.
- `send(paneId, text)` → `backend.pty.write(paneId, text + "\r")`. Reject empty text.
- `interrupt(paneId)` → write `\x1b`.
- `answer(paneId, toolUseId, answer)`:
  - Look up the entry. It must be the newest `question`/`plan` with no answer, otherwise return `{ ok: false, reason: "stale" }`.
  - Encode with ticket 1's encoder and write.
  - Start a timeout of about 8 seconds. If no `tool_result` for that id arrives, emit the entry updated with `needsTerminal: true`. Add that optional flag to the question/plan entry types.
- Expose the methods on the renderer `window.electronAPI` type and preload, matching how other namespaces appear on both desktop and web.

Unit-test the service with a temp-file transcript:
- append lines, assert emitted entries
- partial line handling
- path switch
- the stale-answer guard
- the needs-terminal timeout (fake timers)

## Files to touch
- `electron/chat-mirror/mirror.ts` — new (+ tests)
- `electron/bridge/handlers/chat.ts` — new
- `electron/bridge/events.ts`, `electron/bridge/types.ts`, the handler registry
- preload / `window.electronAPI` types; `src/bridge/` client resolution and its test
