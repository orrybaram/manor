---
title: Update phone E2E for agents-first drawer
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Update phone E2E for agents-first drawer

The drawer now opens on the agents view. Specs that tap `workspace-item` inside `sidebar-drawer` must first tap `drawer-projects-row`. Selectors for `home-row`, `tasks-row`, `search-row` and `notifications-row` should keep working unchanged.

1. Update `tests/e2e/phone.spec.ts` and `tests/e2e/mobile-audit.spec.ts` (and `tests/e2e/helpers/mobile-audit.ts` if it taps drawer workspaces) so workspace taps open the projects view first. Grep for `workspace-item` under a drawer locator.
2. Add a test in `tests/e2e/phone.spec.ts`: open the drawer and expect `drawer-new-agent`, `drawer-settings` and `drawer-projects-row`. Tap `drawer-settings` → the settings modal is visible. Tap `drawer-projects-row` → `workspace-item` is visible, then `drawer-back-to-agents` returns. Close and reopen the drawer → the agents view again.
3. If `tests/e2e/helpers/fake-agent` can produce a requires-input agent cheaply, assert that it shows as a `drawer-agent-row[data-needs-you]`. Otherwise skip this and note it.

Run the touched specs as the README in `tests/e2e/` describes. rtk eats Playwright output, so use `rtk proxy` to run them.

## Files to touch
- `tests/e2e/phone.spec.ts`
- `tests/e2e/mobile-audit.spec.ts`
- `tests/e2e/helpers/mobile-audit.ts` (only if needed)
