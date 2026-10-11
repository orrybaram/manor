---
title: Parse skill listings and slash-command entries from the transcript
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Parse skill listings and slash-command entries from the transcript

ADR-217 D1 and D2. Everything is in the pure parser. Read the ADR's Context section for the exact JSONL shapes seen in Claude Code v2.1.281–v2.1.296.

## Skill listing (D1)
- In `pushInner`, before the `type !== "user" && type !== "assistant"` early return, handle `type === "attachment"` (sidechain lines are already skipped). If `parsed.attachment.type === "skill_listing"`:
  - `isInitial === true` → clear the skills map first.
  - Parse `content` (string) lines matching `/^- ([^:\s][^:]*?): (.*)$/` into name → description. Names may contain `:` as a plugin prefix (`anthropic-skills:pdf`), so split on the first `": "`, not the first `:`. Write a small helper and test it.
  - For each string in `names[]` (if an array), set the description from the parsed lines, or `""`. If `names` is missing, use the parsed lines.
  - The attachment returns `[]`: no ChatEntry.
- Add `export type ChatSkill = { name: string; description: string }`.
- Add public `skills(): ChatSkill[]` (sorted by name) and `hasSkillListing(): boolean` (true once any listing has been seen).

## Command entry (D2)
- Add a `ChatEntry` variant `{ kind: "command"; id: string; ts: string; name: string; args: string; output?: string }`. `name` has no leading `/`.
- In `userText` (and the string-content path), before `isMetaText`:
  - If the text contains `<command-name>/…</command-name>` (in either tag order relative to `<command-message>`), extract the name and `<command-args>` (trimmed, `""` if absent), add a `command` entry with id = uuid, and remember its id as `lastCommandId`.
  - If the text starts with `<local-command-stdout>`, take its inner text, trimmed. If non-empty and `lastCommandId` exists, replace that entry with `{ ...existing, output: text.slice(0, MAX_DETAIL) }` and return it (update semantics, as in `resolve`). Otherwise drop it.
  - All other meta texts stay dropped as today.
- Check `src/electron.d.ts:461` re-exports `ChatEntry`. Export `ChatSkill` the same way.

## Tests
`electron/chat-mirror/__tests__/transcript.test.ts`:
- An initial listing gives skills with descriptions, including a `plugin:skill` name.
- A delta listing (`isInitial: false`) adds to the existing skills.
- A second initial listing replaces them.
- A malformed attachment (no content, non-array names, garbage) is ignored without throwing.
- Sidechain listings are ignored.
- Command lines in both tag orders, with and without args.
- Stdout attaches to the last command as an update with the same id. Empty stdout and stdout with no prior command are dropped.
- `<local-command-caveat>` is still dropped.

## Files to touch
- `electron/chat-mirror/transcript.ts` — attachment handling, skills map, `command` entry
- `electron/chat-mirror/__tests__/transcript.test.ts` — cases above
- `src/electron.d.ts` — re-export `ChatSkill`
