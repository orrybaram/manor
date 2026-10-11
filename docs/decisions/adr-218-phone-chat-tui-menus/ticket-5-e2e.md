---
title: E2E for the choice sheet and the menu handoff
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# E2E for the choice sheet and the menu handoff

ADR-218 D4. Extend `tests/e2e/phone-chat.spec.ts`, following how ADR-217's tests set up the fake agent, its transcript and the phone page.

- **Choice sheet**: type `/mod`, pick `/model`. `command-choice-sheet` is visible. Tap `command-choice-sonnet`. The PTY receives `/model sonnet` then Enter (assert as the existing send tests do), and the pane stays on the chat view.
- **Handoff**: type `/config` and send it bare. The pane switches to the terminal and `menu-key-bar` is visible. Tap `menu-key-down` and the PTY receives `\x1b[B`. Append a `<command-name>/config</command-name>` line, with a current timestamp and a `<local-command-stdout>` line, to the fake transcript. The pane returns to the chat and the bar is gone.
- **Back to chat**: send `/config` bare, tap Back to chat, and the chat shows with no transcript line written.
- Update ADR-217's "interactive" test (pick `/model` and send → terminal) to fit: `/model` now opens the sheet, so either use its "Open menu in terminal" row or switch that test to `/config`.
- Run the phone-chat E2E suite and record the result. Playwright output may be swallowed by the rtk proxy, so use `rtk proxy` if needed.

## Files to touch
- `tests/e2e/phone-chat.spec.ts`
- any fixture/helper the spec uses to write the fake transcript
