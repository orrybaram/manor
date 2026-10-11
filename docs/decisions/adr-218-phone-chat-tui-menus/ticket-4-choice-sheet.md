---
title: Choice sheet for commands with fixed arguments
status: todo
priority: medium
assignee: sonnet
blocked_by: [1, 3]
---

# Choice sheet for commands with fixed arguments

ADR-218 D2. Read the ADR first. Blocked by ticket 3 only because both touch `ChatComposer.tsx`.

- New `src/components/phone/ChatPane/CommandChoiceSheet.tsx`, styled like and positioned where `SlashCommandMenu` is (reuse its CSS classes in `ChatPane.module.css` where they fit). Props: `command: ChatCommand` (with `choices`), `selectedIndex`, `onChoose(value)`, `onOther()`, `onOpenInTerminal()`, `listboxId`. Rows are `ui/Button`s: a header line `/<name>`, one row per choice (label + muted description), then "Other…" and "Open menu in terminal". Use `role="listbox"` / `role="option"` and `aria-activedescendant`, as the slash menu does. `data-testid="command-choice-sheet"`, and `command-choice-<value>` on each choice.
- `useSlashCommands.ts`: expose the picked command so the composer can tell whether it has `choices` (e.g. `pick(index)` returns `{ kind: "text", text, caret } | { kind: "choices", command }`). Add sheet state to the composer or the hook, whichever stays simpler: `choiceFor: ChatCommand | null` plus its own selected index.
- `ChatComposer.tsx`:
  - Picking a command with `choices` opens the sheet in place of the menu, and the composer text is unchanged.
  - `onChoose(value)` sends `/<name> <value>` through the same path as `send()`. Factor `send()` into `sendText(text)` so both use it, including error handling and `opensMenu` (which is false here, by D1). Then close the sheet and clear the composer.
  - `onOther()` closes the sheet and sets the text to `/<name> ` with the caret at the end, focused (as `pick` does today).
  - `onOpenInTerminal()` sends `/<name>` bare. That opens the menu, so it starts the ticket-3 handoff.
  - Keyboard while the sheet is open: ArrowUp/Down move, Enter picks the selected row, Esc closes the sheet and leaves the text alone. Tapping outside closes it too.
- Component test, following the existing ChatPane / composer tests and mocking `window.electronAPI.chat`: picking `/model` shows the sheet, tapping Sonnet calls `chat.send(paneId, "/model sonnet")` and doesn't switch the view, "Other…" prefills `/model `, and Esc closes the sheet without sending.

## Files to touch
- `src/components/phone/ChatPane/CommandChoiceSheet.tsx` (new)
- `src/components/phone/ChatPane/ChatComposer.tsx`
- `src/components/phone/ChatPane/useSlashCommands.ts`
- `src/components/phone/ChatPane/ChatPane.module.css`
- tests under `src/components/phone/ChatPane/__tests__/`
