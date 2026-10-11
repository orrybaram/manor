---
title: E2E for the slash-command menu and command chips
status: done
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# E2E for the slash-command menu and command chips

ADR-217 D6. Extend `tests/e2e/phone-chat.spec.ts`, following how it sets up the fake agent, its transcript and the phone page.

- Seed the fake transcript with a `skill_listing` attachment line (`isInitial: true`, two skills, one with a `plugin:` prefix) and a delta listing adding a third. Copy the real line shape from ADR-217 Context.
- Test 1 (menu): on the phone, type `/` in `chat-composer-input`. The menu lists built-ins and the seeded skills. Type `plu` and check the plugin skill ranks first. Tap it, and the input reads `/plugin:skill ` (with the real seeded name). Type args, send, and check the PTY received `/plugin:skill args` followed by Enter (assert the same way the existing send test does).
- Test 2 (chip): append a command line (`<command-name>/clear</command-name>…`) then a `<local-command-stdout>done</local-command-stdout>` line to the transcript. `chat-command` appears with `/clear`. Tapping it shows `done`.
- Test 3 (no listing): a transcript with no listing shows built-ins and the "Skills appear after your first message." footer.
- Test 4 (interactive): pick `/model` and send. The pane switches to the terminal view.
- Run the phone-chat E2E suite and record the result. Note the project's E2E gotchas in memory: Playwright output may be swallowed by the rtk proxy, so use `rtk proxy` if needed.

## Files to touch
- `tests/e2e/phone-chat.spec.ts` — new cases
- any fixture/helper the spec uses to write the fake transcript
