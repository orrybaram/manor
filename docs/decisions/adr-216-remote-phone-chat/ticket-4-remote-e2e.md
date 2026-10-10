---
title: Remote-host E2E for the phone chat
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Remote-host E2E for the phone chat

Read `tests/e2e/remote-host.spec.ts` and its harness (`pnpm test:e2e:remote-host`, `scripts/test-remote-e2e.mjs`, which can use docker). Add a phone-chat case on a remote project:

1. Start `tests/e2e/helpers/fake-agent-transcript.sh` in a pane on the remote host. Check that the fake agent's hook path reaches the remote `HookListener`, as Manor's hook does there.
2. Pair a phone, open that pane, and check that the chat shows the question card.
3. Tap an option. The input log on the remote shows Down, Down, Enter, and the card collapses to the answer.

If the harness can't deliver hooks from the fake agent on the remote, say so and stop at what is testable. **Don't run Playwright.** The orchestrator runs it.

## Files to touch
- `tests/e2e/remote-host.spec.ts`, or a new `tests/e2e/remote-phone-chat.spec.ts` next to it
- `tests/e2e/helpers/fake-agent-transcript.sh` only if the remote needs a tweak
