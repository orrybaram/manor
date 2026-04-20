---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-128: Playwright smoke suite for renderer UI

## Context

Per issue #11 in `docs/ARCHITECTURE-ISSUES.md`, Manor has unit coverage (vitest) for stores, managers, and the daemon, but **zero automated coverage of the renderer UI**. Regressions in pane layout, modal focus, and keyboard shortcut interactions are caught only by manual testing and get logged in the ADR history as incidents.

Electron apps tend to live a long time — users keep sessions open for days — so a bad render path produces high-cost failures. The cost of manual regression sweeps on every PR is already high enough that the team skips them.

**Existing state:**
- Vitest covers `src/**/*.test.ts` and `electron/**/*.test.ts` (see `vitest.config.ts`).
- No Playwright, WebdriverIO, or Spectron setup exists.
- No `data-testid` attributes anywhere in the renderer.
- App launch is straightforward: `dist-electron/main.js` after `vite build`.
- Two filesystem roots (`~/.manor`, `~/Library/Application Support/Manor`) are both derived from `os.homedir()` in `electron/paths.ts`, so redirecting `$HOME` cleanly isolates test state.

**Critical flows identified** (per issue #11): new workspace → new terminal → agent status detected → pane split → pane close.

## Decision

Introduce a **thin Playwright smoke suite** that runs against a local dev build (not the packaged `.dmg`). Keep scope deliberately small: one framework-shaped test that exercises the critical pane lifecycle, plus the infrastructure to grow the suite later.

**What ships:**

1. `@playwright/test` as a dev dependency. Use `playwright._electron.launch()` to drive a built Electron app (`vite build` → `dist-electron/main.js`).
2. `playwright.config.ts` at repo root. Single project targeting Electron. Retries=0 locally. Sequential (workers=1) — Electron can't share a daemon socket across parallel instances.
3. `tests/e2e/` directory with a `fixtures.ts` module that:
   - Provisions a temp directory for `$HOME` before launch.
   - Provisions a temp git repo under that temp home so "New Workspace" has a real project target.
   - Launches Electron with `env.HOME` overridden.
   - Yields `{ app, window }` to the test.
   - Tears down: closes the app and removes the temp dir.
4. `tests/e2e/smoke.spec.ts` — one test covering:
   - App boots, main window visible.
   - Import the seeded test project via the setup wizard or sidebar entry point.
   - Create a workspace for that project (default branch name, local base branch).
   - Terminal pane renders (query by `data-testid`, not xterm canvas text).
   - Split pane right via keyboard shortcut.
   - Assert two panes rendered.
   - Close the active pane.
   - Assert one pane remains.
5. **Minimal stable selectors**: add `data-testid` attributes only to the DOM nodes the smoke test touches. Do NOT add testids broadly — that can happen incrementally as new tests are written. Target list:
   - `NewWorkspaceDialog`: root, project select trigger, name input, base-branch select trigger, submit button.
   - Sidebar: "New Workspace" button/trigger for a given project.
   - Workspace pane root (so we can count panes).
   - TerminalPane root (so we can detect terminal rendering without touching xterm).
   - Project setup wizard entry points that matter for seeding.
6. `pnpm test:e2e` script in `package.json`. Runs `vite build && playwright test`. Keep it out of the default `pnpm test` (vitest) — running both is slow and most edits don't need E2E.
7. README updates: one paragraph under an "E2E tests" subsection documenting how to run the suite locally.

**What is explicitly out of scope:**

- **Agent status detection**. Spawning a real Claude process in CI is out of scope — it needs a mocked hook server or a stub agent, which is a separate ADR.
- **CI integration**. Add Playwright to CI workflow in a follow-up once the suite is stable locally.
- **Broad `data-testid` rollout**. Only the nodes the smoke test touches.
- **Visual regression / screenshot snapshots**. Fragile on Electron across machines.
- **Packaged-app testing**. Dev build is enough — packaging is an `electron-builder` concern covered elsewhere.
- **Cross-platform**. macOS only for now; Linux/Windows can follow when/if the app targets them seriously.

**Selector strategy.** Prefer `data-testid` over role-based queries. Radix UI's accessible names are good but change with refactors; testids express intent and survive re-styling. Keep the testid vocabulary small and document it in `tests/e2e/README.md`.

**Test isolation strategy.** Every test launches a fresh Electron instance with a brand-new `$HOME`. No state bleeds between tests. Daemon socket, projects.json, window bounds, keybindings — all under the temp dir, all cleaned up on teardown.

## Consequences

**Better:**
- A broken render path in a workspace/pane flow fails CI locally before merge.
- New UI features can ship with one smoke test each, building confidence over time.
- `data-testid` pattern is established — future tests don't rebikeshed selector strategy.
- Test isolation via `$HOME` redirection is clean and reliable given `paths.ts` already centralizes filesystem access.

**Worse:**
- `pnpm test:e2e` is slow (~30s minimum for boot + one flow). Developers won't run it every save. This is fine — it's for pre-push / CI.
- Adds `@playwright/test` + ~200MB of browser binaries to the dev dependency tree. Playwright is mostly extraneous for an Electron-only app, but `_electron` lives inside the same package — no lighter alternative.
- Selectors are now semi-public contracts. Renaming a `data-testid` without updating the test is a foot-gun. Mitigated by keeping the testid surface small.
- The first smoke test is load-bearing: if it flakes, the suite's credibility collapses. Must be deliberate about picking a rock-solid flow for the first test.

**Risks:**
- **Native module rebuild**. `node-pty` must be rebuilt against the Electron ABI before Playwright launches. `pnpm install` already runs `electron-rebuild` (postinstall), so this works out of the box, but CI needs to respect postinstall hooks.
- **Daemon lifecycle**. The terminal-host daemon is spawned lazily when the first terminal opens. The smoke test must wait for the daemon to be ready before asserting on the pane — use `data-testid` on a DOM element that only renders once the terminal is attached.
- **Window bounds persistence**. Already handled by the temp-`$HOME` strategy.
- **Flaky first run**. Electron startup time varies on macOS; tests need generous but bounded timeouts (default 30s, explicit `expect.poll` where needed).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
