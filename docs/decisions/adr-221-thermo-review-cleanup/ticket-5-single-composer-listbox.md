---
title: One listbox model for slash menu and choice sheet
status: todo
priority: high
assignee: opus
blocked_by: [4]
---

# One listbox model for slash menu and choice sheet

`ChatComposer.tsx` (~53-56, 77-87, 116-149, 191-199, 210-259) runs two listbox state machines: the `/` menu and the new choice sheet (`choiceFor`, `choiceIndex`, `choiceListboxId`). Each has its own ArrowUp/Down/Enter/Escape switch with the same preventDefault/stopPropagation, its own nested aria ternaries, and the "choices, then Other…, then terminal" row layout is index arithmetic in three places (`ChatComposer.tsx:145-148`, `:211` `+ 2`, `CommandChoiceSheet.tsx:88-90`). `useSlashCommands.pick` returns a `{kind:"text"}|{kind:"choices"}` union only for the composer to branch on.

Do:
1. Define a listbox level interface: `{ listboxId, rows: { key, label, description?, testId, activate }[], selectedIndex, move(delta), activateSelected(), dismiss() }`.
2. Make the choice sheet the second level of the `/` menu — inside `useSlashCommands` or a sibling `useChoiceSheet` composed by it — so the composer sees one active level at a time. The three `choose*` closures become each row's `activate`.
3. Composer: one keyDown switch over the active level (Tab activates only at the command level, as today), one set of aria attributes.
4. `CommandChoiceSheet` renders `rows` with no index math; `SlashCommandMenu` likewise if it fits.
5. Keep all test ids and behaviour (including "dismissing the choice sheet keeps the / menu shut" and "any edit reopens a dismissed / menu" from ADR-218). Update `__tests__/ChatPane.test.ts`, `slash-commands.test.ts`. Do NOT run Playwright.

## Files to touch
- `src/components/phone/ChatPane/ChatComposer.tsx`
- `src/components/phone/ChatPane/useSlashCommands.ts`
- `src/components/phone/ChatPane/CommandChoiceSheet.tsx`
- `src/components/phone/ChatPane/SlashCommandMenu.tsx`
- `src/components/phone/ChatPane/__tests__/*`
