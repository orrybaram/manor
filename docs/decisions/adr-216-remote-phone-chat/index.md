---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-216: The phone chat view for agents on remote hosts

Follow-up to ADR-215, whose D4 limited the transcript mirror to agents on the local host. The vocabulary for hosts is ADR-160's and ADR-183's.

## Context

ADR-215 gave a phone a chat view of a Claude pane. It is built by tailing the agent's JSONL transcript in main (`electron/chat-mirror/mirror.ts`) and pushing parsed entries over the bridge. For an agent on a remote host it returns `unavailable: "remote"`, and the phone falls back to the terminal. The two gates are `mirror.ts` `resolve()` (`hostId !== LOCAL_HOST_ID`) and the renderer's `chatTranscriptPath()` (`src/components/phone/ChatPane/chat-view.ts`). Remote projects are a first-class way to run agents (ADR-160, ADR-178), so this gap matters.

What already works for remote agents:

- **The transcript path arrives.** The same `agent-hook.js` runs on the remote and sends `transcriptPath`. The remote `HookListener` keeps every query parameter. `HostHookFeed` replays it into `AgentHookServer.ingestHookPayload(payload, { hostId })`, and `captureTranscriptPath` stores it on the agent. So a remote agent's `transcriptPath` is already set: it is a path on the *remote* filesystem.
- **Answers and messages already reach the remote.** `chat.send`, `chat.answer` and `chat.interrupt` write through `backend.pty.write`, which `RoutedBackend` sends to the pane's host.
- **Remote command execution exists.** `backendRegistry.get(hostId)` exposes `Exec`. Remotely, `Exec.file` and `Exec.stream` are requests multiplexed over the host's existing ssh session (`remote-exec.ts` → `TerminalHostClient`), not a new ssh connection per call. `Exec.readFile` reads whole files only, with no offset.

The only missing piece is **reading the file incrementally on the remote machine**.

Options considered:

1. **New daemon protocol messages**, e.g. `readFile {offset, maxBytes}` or a `transcriptLines` stream event in `electron/terminal-host/types.ts`. This is the cleanest wire format, but every remote host needs a daemon upgrade. Replacing a stale daemon kills its sessions (ADR-160 §4, `isDaemonStale`), and the client must handle old daemons that answer "unknown request type" or ignore the message.
2. **A long-lived `tail -F` through `Exec.stream`.** This pushes from the remote with no protocol change. But it is one remote process per watched pane, its lifetime has to be tied to subscribe and unsubscribe and to host reconnects, and `tail -F` behaves differently across platforms.
3. **Incremental reads with `Exec.file` (chosen).** One short shell command per read reports the file's size and the bytes after the last offset. A read is triggered by the agent's own hook events, which already arrive for remote agents, plus a slow poll while someone is watching. This works on every deployed host today, has no daemon or protocol change, and leaves nothing running on the remote between reads.

## Decision

**D1: The mirror reads through a `TranscriptSource`.** `mirror.ts` stops calling `fs` directly. A source exposes:

- `read(path, offset) → { size, data } | { error }`: the bytes from `offset` to the current end. `size < offset` means the file was truncated or replaced, and the mirror resets as it does today.
- An optional `watch(path, onChange) → unwatch`.

`LocalTranscriptSource` wraps today's `fs` code (open, stat, chunked read at an offset, `fs.watch` with the poll fallback) and keeps its current behaviour. The mirror chooses a source per agent from `agent.hostId`.

**D2: `RemoteTranscriptSource` reads through the host's `Exec`.** One `exec.file("sh", ["-c", SCRIPT, "sh", path, String(offset)])` call per read:

- The script prints the file's byte size on the first line, then `tail -c +$((offset+1))` of the file, capped with `head -c` at that size.
- The path and offset are passed as positional arguments, never interpolated into the script.
- `maxBuffer` and the cap bound a single read to a few MiB. A longer backlog takes several reads.
- The output comes back as a UTF-8 string, so the mirror only ever advances its offset by the **byte length of complete lines**. JSONL lines are whole UTF-8 sequences, so complete lines decode exactly, and a split character can only fall in the partial tail line, which is kept back as today.
- A missing file reports size 0. A host that is offline, or an exec that fails, returns `{ error }`. The mirror then reports `unavailable: "host-offline"` and retries on the next trigger instead of throwing.

**D3: Remote reads are triggered by hooks, backed by a poll.** There is no remote `fs.watch`. While at least one subscriber is attached:

- Every hook event for the pane's agent pokes `mirror.poke(paneId)`. That covers PreToolUse, PostToolUse, Stop, Notification and UserPromptSubmit, which are the moments the transcript grows. The poke runs from the same place `captureTranscriptPath` runs.
- A 2-second poll catches anything a hook doesn't cover, such as streamed assistant text before Stop.
- Reads per pane never overlap: a poke during a read sets a "read again" flag.
- After the last unsubscribe, nothing runs.

ADR-215 D5's needs-terminal timeout (about 8 seconds) still holds: an answer's `tool_result` follows a PostToolUse hook, which triggers a read straight away.

**D4: Remote agents get the chat on the phone.**

- `resolve()` no longer refuses remote agents.
- `chatTranscriptPath()` in the renderer drops its `isRemoteHost` check. The `"remote"` reason stays in the type for old renderers but is no longer produced.
- `ChatUnavailableReason` gains `"host-offline"`. `ChatPane` shows "This host is offline" with the existing "Show terminal" button. This is also what the terminal shows (`HostOfflineBanner`).
- `pickPaneAgent` and the stale-answer guard are unchanged.

**D5: No daemon or protocol change.** `TERMINAL_HOST_PROTOCOL` stays at 6. If incremental reads ever prove too slow or too costly, option 1 can come later behind the same `TranscriptSource` interface.

## Consequences

**Gets better.**
- A phone can read, answer and steer Claude agents on remote hosts exactly as it does local ones.
- It works on every remote host already deployed, without an upgrade.

**Gets harder / risks.**
- **Latency.** Remote updates arrive on the next hook or poll tick (2 seconds or less), not on a local `fs.watch` event. That is acceptable for a phone.
- **Load.** One small exec per pane every 2 seconds while a phone watches that pane, multiplexed over the existing ssh session, and nothing when no one watches.
- **Shell dependency.** The script assumes a POSIX `sh` with `wc`, `tail` and `head` on the remote. That holds wherever `manor-host` runs today (macOS and Linux), and the script uses no GNU-only flags. The spike in ticket 2 confirms it on both.
- **Offset bookkeeping across decode boundaries.** This is new logic and the most likely source of subtle bugs. Ticket 2 covers it with multi-byte fixtures.
- **Tests.** End-to-end coverage needs the remote-host harness (`tests/e2e/remote-host.spec.ts`, ADR-160 ticket 12), which needs an sshd. That harness is slow and may not run everywhere.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
