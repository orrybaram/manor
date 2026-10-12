---
title: Parse background and delegated work into task entries
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Parse background and delegated work into task entries

ADR-224 D2. Everything happens in the Claude parser. The `task` entry is
agent-neutral: don't put Claude field names into it.

1. In `electron/chat-mirror/transcript.ts`, add the `task` member to `ChatEntry`
   exactly as in ADR D2, and export `ChatTaskEntry = Extract<ChatEntry, {kind:"task"}>`.
2. `tool_use` handling:
   - `name` is `Agent` or `Task` → `task`, taskKind `"agent"`. `title` =
     `input.description`, else `subagent_type`, else `"Agent"`. `agentType`
     = `input.subagent_type`, `model` = `input.model`, `background` =
     `input.run_in_background === true`, status `"running"`,
     `hasTranscript: false`.
   - `Bash` with `input.run_in_background === true` → `task`, taskKind
     `"shell"`. `title` = description, else the command's first line.
   - Everything else is unchanged.
3. `tool_result` handling (`resolve`): it needs the whole line, because
   `toolUseResult` sits at the top level, not in the block. Pass
   `parsed.toolUseResult` through to `resolve`. For a `task`:
   - If `toolUseResult` is an object with a string `agentId`: set `taskRef`.
     When `taskKind === "agent"`, set `hasTranscript = true`.
   - If `toolUseResult.isAsync === true`, or `entry.background` is set: the
     task keeps `status: "running"`, and `result` stays unset. A background
     Bash result text looks like "Command running in background with ID: …";
     its `toolUseResult` may carry `backgroundTaskId`. If it does, set
     `taskRef` from it.
   - Otherwise: `status` = `is_error ? "error" : "ok"`, `result` = the text
     sliced to `MAX_DETAIL`.
4. `<task-notification>`: read `<tool-use-id>`. If it names a `task` entry,
   replace that entry with `status` mapped from `<status>` (`completed` → ok,
   `failed` → error, `killed` → killed, anything else → ok) and `result` =
   `<summary>`. Return the updated entry, and create **no** notice. Otherwise
   keep the current notice behaviour.
5. Tests in `electron/chat-mirror/__tests__/transcript.test.ts`, using the
   real shapes in the ADR Context:
   - Async agent: launch, then async result (still running, taskRef set,
     hasTranscript), then notification (ok, result = summary, no notice).
   - Foreground agent: tool_result → ok, with the result text.
   - Background Bash: running, then notification killed → killed.
   - A notification with an unknown tool-use-id still produces a notice.
   - A legacy `Task` tool name.
   - Defensive cases: no `toolUseResult`, and a malformed notification.
6. Renderer type: make sure `src/electron.d.ts` re-exports the new member
   (it re-exports `ChatEntry`). Then make `ChatEntryView` handle `task`
   minimally (render a `notice`-style row with the title and status dot) so
   nothing disappears before ticket 4. Check
   `src/components/phone/ChatPane/chat-entries.ts` so tasks do NOT fold into
   tool groups.

## Files to touch
- `electron/chat-mirror/transcript.ts`
- `electron/chat-mirror/__tests__/transcript.test.ts`
- `src/components/phone/ChatPane/ChatEntryView.tsx`, `chat-entries.ts` — minimal task row, no grouping
