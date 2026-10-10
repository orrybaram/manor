---
title: Pure Claude transcript parser
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Pure Claude transcript parser

ADR-215 D3. A pure module with no I/O.

`electron/chat-mirror/transcript.ts`:

```ts
export type ChatEntry =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant"; id: string; ts: string; text: string }
  | { kind: "tool"; id: string; ts: string; name: string; summary: string; status: "pending" | "ok" | "error"; detail?: string }
  | { kind: "question"; id: string; ts: string; questions: PickerQuestion[]; answer: string | null }
  | { kind: "plan"; id: string; ts: string; plan: string; outcome: string | null };
```

Define `PickerQuestion` locally in `transcript.ts` as `{ question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }`. Ticket 1 runs in parallel and defines the same shape in `picker-keys.ts`; ticket 4 unifies the two. Do not create `picker-keys.ts`.

- `class TranscriptParser { push(line: string): ChatEntry[] }` returns the entries that are new or updated by that line, with stable `id`s. Updating means a `tool_result` resolves a pending `tool`/`question`/`plan` with the same id. Also expose `entries(): ChatEntry[]`.
- Line shape: each JSONL line has `type` (`user`/`assistant`/others), `message.content` (string or block array), `timestamp`, `uuid`, `isSidechain`, and on tool results `toolUseResult`.
  - Skip sidechain lines, `thinking` blocks, and user lines that are only `tool_result`s (those resolve tools instead).
  - Skip meta/system/command-output lines: look for `isMeta`, and content starting with `<command-` / `<local-command` / `<system-reminder>`.
  - Check real transcripts in `~/.claude/projects/*/*.jsonl` to confirm field names.
- Tool summaries:
  - Bash → `description` or the first line of `command`
  - Read/Edit/Write → `file_path`
  - Grep/Glob → `pattern`
  - otherwise → the tool name
- `AskUserQuestion` → a `question` entry. Its answer comes from the tool_result text.
- `ExitPlanMode` → a `plan` entry using `input.plan`.
- Malformed JSON, unknown `type`, and unknown block types are skipped silently. Never throw.

Tests in `electron/chat-mirror/__tests__/transcript.test.ts` use small hand-written fixture lines, modelled on real transcripts but with content scrubbed. Cover:
- pairing
- a pending question, then answered
- a plan
- sidechain skip
- meta skip
- malformed line
- an unknown block

## Files to touch
- `electron/chat-mirror/transcript.ts` — new
- `electron/chat-mirror/__tests__/transcript.test.ts` — new
