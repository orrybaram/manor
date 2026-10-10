---
title: Phone chat view with picker cards and composer
status: todo
priority: high
assignee: opus
blocked_by: [4]
---

# Phone chat view with picker cards and composer

ADR-215 D6, D7. Read ADR-181 (the phone layout), `.claude/rules/ui-components.md`, `src/components/phone/`, `src/components/workspace-panes/LeafPane.tsx` and `TerminalPane/TerminalPane.tsx` first. Use the `react` skill's conventions.

## Toggle

- In `LeafPane`, when `useLayoutMode() === "phone"` and the pane's agent (from the agents store) is a Claude agent with a `transcriptPath`, render a Chat | Terminal segmented control in the pane. Reuse `ui/ToggleGroup`.
- Keep `TerminalPane` mounted and hide it when chat is shown. It must not unmount or change geometry (ADR-181 D1).
- Chat is the default. Remember the choice per paneId in `localStorage`, with reads and writes in try/catch.
- On desk, render no toggle.

## `src/components/phone/ChatPane/`

- `ChatPane.tsx` calls `chat.getHistory` on mount and subscribes to `chat.onEntry`. It upserts entries by id and auto-scrolls to the bottom unless the user has scrolled up.
- If `getHistory` returns `ok: false`, show a short note with a "Show terminal" button.
- Entry rendering:
  - `user`: right-aligned bubble
  - `assistant`: left-aligned, rendered as markdown. Use whatever markdown renderer the app already uses; check `package.json`. If none exists, use pre-wrapped text and don't add a dependency.
  - `tool`: a compact one-line card with name, summary and a status dot. Tap to expand `detail`.
  - `question` with no answer: a card per question showing header and question, with one full-width `<Button>` per option (label plus description). For `multiSelect`, the buttons toggle and a Submit button appears. Each single-select question also gets an "Other…" choice that reveals a text field. Multi-select questions get no Other in the chat, because the encoder refuses it.
    - For more than one question, collect all answers and then send one `chat.answer`.
    - Disable the card while sending.
    - On `stale`, `unsupported` or `needsTerminal`, show "Answer in terminal" with a button that switches to the Terminal view.
  - Answered question: a compact summary.
  - `plan`: the plan text (collapsed beyond about 12 lines) with an Approve button (`chat.answer` with `{ kind: "plan-approve" }`) and a "Change plan in terminal" button that switches to the Terminal view. Rejecting from the chat is deliberately unsupported (see the ADR's spike findings).
- Needs-you banner: when the agent's status is `requires_input` and there is no unanswered question or plan entry, show "Claude needs you" with an "Open terminal" button.

## Composer

- Pinned at the bottom with `KeyboardLift`, using `<EmojiTextarea>`.
- Send calls `chat.send`. Stop calls `chat.interrupt`; show it while the agent status is thinking or working.
- Keep the input font size at least 16px so iOS doesn't zoom.

Styles go in a CSS module. Phone rules for anything portaled key off `:root[data-layout="phone"]` (ADR-181 D5). Use theme tokens, not hard-coded colours.

## Tests

- Component tests for:
  - entry rendering
  - the question card building the right `PickerAnswer`s (single, multi, other, two questions)
  - the stale fallback
  - the toggle defaulting and persisting
- If the repo has phone E2E specs (search `e2e/` for ADR-181 phone tests), add one: a mocked chat history renders, and tapping an option calls `chat.answer`.

## Files to touch
- `src/components/workspace-panes/LeafPane.tsx` — the toggle
- `src/components/phone/ChatPane/*` — new
- `src/components/phone/Phone.module.css` if shared phone styles are needed
- tests alongside
