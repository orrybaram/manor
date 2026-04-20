---
title: Write the pane-lifecycle smoke test
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Write the pane-lifecycle smoke test

Replace the placeholder smoke test from ticket 1 with the real flow: **new workspace → terminal renders → split pane → close pane.**

## What to do

1. Update `tests/e2e/smoke.spec.ts`. Use the fixture from `fixtures.ts`.

2. **Flow to cover** (single `test("pane lifecycle", ...)`):
   a. Launch Electron with the fixture. `tempHome` already has `<tempHome>/test-project` seeded as a git repo on `main`.
   b. If the project-setup-wizard appears on fresh launch (testid `project-setup-wizard`), dismiss/complete it. If dismissing isn't possible, drive it through to completion using the seeded test-project path.
   c. **Import uses native file picker.** Ticket 2 confirmed `import-project-path-input` and `import-project-submit` do NOT exist as DOM nodes — clicking `import-project-button` calls `window.electronAPI.dialog.openDirectory()` which opens the OS-native picker. The preload bridge is backed by `dialog.showOpenDialog()` in the main process. **Stub it** before clicking: `await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, seededProjectPath);`. Then click `import-project-button` and wait for the project to appear in the sidebar. Verify the stub works by watching for a project row to render.
   d. Click `sidebar-new-workspace-button` for the imported project.
   e. Wait for `new-workspace-dialog` to be visible.
   f. Fill `new-workspace-name-input` with `smoke-test-workspace`.
   g. Leave project / base branch at defaults if already populated. Otherwise, select the imported project and `main` as the base branch via the select triggers.
   h. Click `new-workspace-submit`.
   i. Wait for a `terminal-pane` to appear in the workspace area. Generous timeout (up to 30s) — daemon has to boot on first terminal.
   j. Assert `await window.locator('[data-testid="workspace-pane"]').count()` equals 1.
   k. Trigger split-right. Prefer the keyboard shortcut; look up the binding from `src/lib/keybindings.ts` (look for `split-panel-right`). Dispatch via `window.keyboard.press(...)`.
   l. Assert `workspace-pane` count is 2 (poll up to 5s).
   m. Close the active pane via the `close-pane` keyboard shortcut (same keybindings file). If a confirmation dialog appears (`CloseAgentPaneDialog`), confirm it — but since no agent is running, it shouldn't.
   n. Assert `workspace-pane` count is back to 1.

3. **Test isolation**: each test run gets a fresh temp home from the fixture. Do not persist any state.

4. **Timeouts & waits**:
   - Use `expect(locator).toBeVisible()` with Playwright's auto-waiting — don't sprinkle arbitrary `waitForTimeout`.
   - For pane-count assertions, use `await expect.poll(() => window.locator('[data-testid="workspace-pane"]').count()).toBe(N)`.

5. **If a step fails because the UI doesn't match expectations**: document what you found in the test file as a TODO comment and mark the test as `test.fixme` with a brief reason. Do NOT silently skip steps. The expectation is a working test — `test.fixme` is only acceptable if ticket 2 flagged that a required testid wasn't addable and this ticket can't work around it.

6. **Sanity check existing tests**: `pnpm test` (vitest) must still pass. `pnpm test:e2e` must pass the full smoke flow end-to-end.

## Files to touch

- `tests/e2e/smoke.spec.ts` — replace placeholder with the real flow.
- (Possibly) `tests/e2e/fixtures.ts` — extend if you need a helper like "dismiss setup wizard" or "stub dialog.showOpenDialog". Keep helpers in the fixture file, not sprinkled across tests.

## Verification

- `pnpm test:e2e` passes the full pane-lifecycle flow locally on macOS.
- The test completes in under 60 seconds.
- Temp `$HOME` is cleaned up on teardown.
- No daemon PID files left behind in the test's temp home (or, if left, only inside the temp home which gets removed).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-128): Write the pane-lifecycle smoke test"

Do not push.
