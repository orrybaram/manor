---
title: E2E — phone new agent picks a target
status: todo
priority: medium
assignee: sonnet
blocked_by: [4]
---

# E2E — phone new agent picks a target

ADR-222. Add specs to `tests/e2e/phone.spec.ts` (or a new `tests/e2e/phone-new-agent.spec.ts`) using the existing phone helpers (`helpers/phone.ts` `openWebApp`/`openClient`, `relayTest` from `helpers/relay-fixture.ts`), seeded projects (`importSeededProject`, `createWorkspace`) and the fake agent (`helpers/fake-agent*.sh`). Never fabricate state from inside the app.

Cases:
1. With an agent tab open, drawer `drawer-new-agent` opens the composer (`phone-empty-composer-input` visible), and no new agent tab/pane was created. `phone-composer-close` returns to the previous tab.
2. Pick a different project and an existing workspace via chips, send a prompt → agent tab opens in that workspace (active workspace changes; fake agent receives the prompt).
3. Tick `phone-target-worktree` on main, send "fix the login bug" → a new workspace named `fix-the-login-bug` (or suffixed) appears and the agent starts in it.
4. Host chip is absent for an unlinked project. (Linked-host coverage only if an existing fixture already provides a second host; otherwise skip and note it.)

Run only the new/changed specs locally; report results.

## Files to touch
- `tests/e2e/phone-new-agent.spec.ts` — new (or extend `phone.spec.ts`)
