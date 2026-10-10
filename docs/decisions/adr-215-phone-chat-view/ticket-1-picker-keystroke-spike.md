---
title: Spike and encode Claude Code picker keystrokes
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Spike and encode Claude Code picker keystrokes

ADR-215 D5. Establish *empirically* which bytes answer Claude Code's AskUserQuestion and ExitPlanMode pickers. Then pin them in a pure encoder.

## Spike

1. Write `scripts/spike-picker-keys.mjs`.
   - It spawns the real `claude` CLI under `node-pty` (already a dependency) in a temporary directory.
   - It sends a prompt that tells Claude to call AskUserQuestion with a given shape.
   - It feeds `@xterm/headless` (already a dependency) to read the screen.
2. Cover these cases:
   - single question, single choice
   - single question, "Other" with free text
   - `multiSelect: true` with 2 choices
   - 2 questions in one call, which brings up the submit/confirm screen
   - ExitPlanMode approve
   - ExitPlanMode reject
3. For each case, try the candidate sequences:
   - Down-arrow ×N then Enter (`\x1b[B`, `\r`)
   - number keys
   - Space or Enter to toggle multi-select
   - Tab or Right to move between questions
4. Confirm the outcome by reading the resulting `tool_result` in the session JSONL under `~/.claude/projects/` (match the session by cwd).
5. Record the working sequences, and the Claude Code version they were tested against (`claude --version`), in a block comment at the top of the encoder.

If `claude` can't run in this environment (auth, network), stop and report that clearly. Don't guess the sequences.

## Encoder

`electron/chat-mirror/picker-keys.ts`:

- Export types `PickerQuestion` (question, header, options `{label, description}[]`, multiSelect) and `PickerAnswer` (per question: `{ kind: "option", indexes: number[] } | { kind: "other", text: string }`).
- Export `encodePickerAnswer(questions: PickerQuestion[], answers: PickerAnswer[]): string` for AskUserQuestion.
- Export `encodePlanAnswer(choice): string` for ExitPlanMode. Use the plan choices the spike finds.
- Throw on out-of-range indexes, or on a `multiSelect: false` question given more than one index.

Write unit tests in `electron/chat-mirror/__tests__/picker-keys.test.ts`, one per spike case, asserting the exact bytes.

## Files to touch
- `scripts/spike-picker-keys.mjs` — new; the spike (kept so it can be rerun when Claude Code changes)
- `electron/chat-mirror/picker-keys.ts` — new; the encoder
- `electron/chat-mirror/__tests__/picker-keys.test.ts` — new
