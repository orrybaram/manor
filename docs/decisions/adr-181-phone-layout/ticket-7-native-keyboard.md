---
title: Typing on a phone is xterm and the native keyboard
status: in-progress
priority: high
assignee: opus
blocked_by: [2, 3]
---

# Typing on a phone is xterm and the native keyboard

ADR-181 D6 — the riskiest ticket. The user chose the native keyboard straight
into xterm, **with no composer and no special-key row**. Build exactly that,
and do not add either. D6 states the accepted cost (no Esc/Tab/Ctrl from a
phone keyboard); your job is to make the chosen path work well, not to argue
it.

## Three things to get right

**1. The keyboard comes up.** iOS raises the soft keyboard only when an input
is focused *synchronously inside a user gesture*. xterm renders into a canvas
and takes keystrokes through a hidden `<textarea>` (`.xterm-helper-textarea`).
On a tap in phone mode, focus the terminal (`term.focus()`, which focuses that
textarea) from the `touchend`/`pointerup` handler itself — not after an
`await`, a `setTimeout` or a state update, all of which lose the gesture. Look
at `useTerminalLifecycle.ts`'s existing `t.focus()` calls (lines ~169, ~439)
for the desk's focus rules and do not break them.

**2. The textarea behaves.** On that textarea set `autocapitalize="off"`,
`autocorrect="off"`, `spellcheck="false"`, and `autocomplete="off"`. A
terminal that capitalises the first letter of `ls` is broken.

**3. The keyboard never resizes the terminal.** This is the one that matters
most, and it is ADR-163/164/165's bug waiting to happen: if opening the
keyboard shrank the terminal's rows, a pane this renderer owns the winsize of
would SIGWINCH on every keyboard toggle, and full-screen TUIs would repaint
their frame into the scrollback each time. Ticket 3 sized the phone shell to
`100lvh` (the *large* viewport) so the keyboard changes no layout height.
Verify nothing reads `window.visualViewport` or `100dvh` to size a terminal,
and that `useTerminalResize` sees no size change when the visual viewport
shrinks. The browser's native scroll-into-view keeps the focused textarea —
which xterm positions at the cursor — above the keyboard.

## Verification

Playwright cannot raise a real soft keyboard, so:

- Unit-test the attribute setting and that focus is called synchronously from
  the gesture handler (a spy on `focus` invoked within the same task as the
  dispatched event).
- A Playwright check (the orchestrator runs it — see below) at a 390×844
  viewport that shrinking the visual viewport does not resize the pane.
- **Write down in your report exactly what could only be verified on a real
  phone**, so the orchestrator can hand it to the user. Do not claim a
  keyboard behaviour you could not observe.

## Do not run Playwright

Previous agents in this repo were killed by a 600s watchdog running E2E. Write
any spec you need; the orchestrator runs it. You may run `pnpm typecheck`,
`pnpm lint` and `npx vitest run`.

## Files to touch
- `src/hooks/useTerminalLifecycle.ts` — synchronous focus on tap in phone mode
- wherever the xterm `Terminal` is constructed/opened — the textarea attributes
- `src/hooks/__tests__/` — new unit tests

## Folded in from ticket 6

**A long-press on a terminal may lose to xterm.** `TerminalPane.tsx` wraps
xterm's container in a Radix `ContextMenu.Trigger`, whose long-press is a
700 ms `pointerdown` timer (gated on `pointerType !== "mouse"`) that **any**
`pointermove` cancels — no distance threshold. Nothing in the codebase gives
xterm's own touch or selection handling special treatment: no `touch-action`
or `user-select` in `TerminalPane.module.css`, no touch xterm options. So on a
real phone a long-press may start an xterm text selection, or a finger's
natural wobble may cancel the timer, and the pane menu never opens.

This ticket owns the terminal's touch handling, so decide it here, and keep it
compatible with the tap-to-focus you are building: a *tap* focuses xterm and
raises the keyboard; a *long-press* opens the pane menu; a *drag* scrolls (or
pans a follower). Say in your report which of those three you could only
reason about rather than observe.
