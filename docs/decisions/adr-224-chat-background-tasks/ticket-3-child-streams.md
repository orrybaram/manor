---
title: Child transcript streams and chat.getTaskHistory / chat.taskEntry
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Child transcript streams and chat.getTaskHistory / chat.taskEntry

ADR-224 D3. The heaviest ticket. Do it in two commits-worth of steps inside
one ticket:

**Step A — refactor, no behaviour change.** Pull the tailing state and logic
out of `PaneMirror`/`ChatMirror` into a `TranscriptStream` class (path,
source, adapter, parser, offset, primed, generation, watch/poll, the
queue/pending read coalescing, readError, `consume`). `PaneMirror` keeps the
pane-only parts (pickers: `awaiting`, `needsTerminal`, `lastSkills`,
`lastContextTokens`) and owns one stream. `mirror.test.ts` must pass
**unchanged** after step A. Run it before going on.

**Step B — child streams.**
1. `claudeAdapter.childTranscriptPath(parentPath, task)`: return null unless
   `task.taskKind === "agent" && task.taskRef`. Otherwise
   `path.posix.join(dirname(parentPath), basename(parentPath, ".jsonl"),
   "subagents", "agent-" + taskRef + ".jsonl")`. Use posix, because remote
   hosts are posix. Unit-test it.
2. `TranscriptParser` takes `{ sidechain?: boolean }`. When it's true, it
   keeps `isSidechain` lines. `claudeAdapter.createParser({child:true})`
   passes it.
3. `ChatMirror`:
   - `getTaskHistory(paneId, taskId)`: catch the parent up, find the task
     entry, resolve the child path (null → `{ok:false, reason:"no-transcript"}`),
     create or reuse the child stream in `PaneMirror.children: Map<taskId,
     TranscriptStream>`, read it, and return `{ok, entries, contextTokens}`.
   - `setTaskWatched(paneId, taskId, watched)`: same mechanics as
     `setWatched`. Published entries go through a new dep,
     `publishTask(paneId, taskId, entry)`.
   - `poke(paneId)` also reads every watched child.
   - Cleanup: a parent reset or `closePane` stops and drops all children.
     Unwatching drops a child whose task is no longer `running`.
4. Bridge:
   - `electron/bridge/events.ts`: add `taskEntry: [paneId: string, taskId:
     string, entry: ChatPush]` under `chat`.
   - `electron/bridge/handlers/chat.ts`: add `getTaskHistory`, plus the
     subscribe/unsubscribe wiring for `chat.taskEntry`, mirroring how
     `chat.entry` calls `setWatched`. Follow how the existing keyed
     subscription tracks first and last subscriber. Look at how
     `publishKeyed("chat","entry",…)` is consumed.
   - `electron/app-lifecycle.ts`: wire `publishTask` to
     `bridgeServer?.publishKeyed("chat", "taskEntry", [paneId, taskId, entry], paneId)`.
   - Expose it in the renderer bridge types (`src/electron.d.ts`, and
     wherever `chat.onEntry` is mapped, e.g. `"chat.onTaskEntry": "chat.taskEntry"`
     in `events.ts`).
5. Tests (`mirror.test.ts`, with a fake source):
   - history of a child.
   - live tail publishes through `publishTask`.
   - a missing child file → empty history, then it fills in.
   - a parent reset drops the children.
   - remote-style source (no `watch`): `poke` reads children.

## Files to touch
- `electron/chat-mirror/mirror.ts` (+ new `electron/chat-mirror/stream.ts` for `TranscriptStream`)
- `electron/chat-mirror/transcript.ts` — sidechain option
- `electron/chat-mirror/adapters/claude.ts` — childTranscriptPath, child parser
- `electron/bridge/events.ts`, `electron/bridge/handlers/chat.ts`
- `electron/app-lifecycle.ts`
- `src/electron.d.ts`
- `electron/chat-mirror/__tests__/mirror.test.ts`, adapter tests
