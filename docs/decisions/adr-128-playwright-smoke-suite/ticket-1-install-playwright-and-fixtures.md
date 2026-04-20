---
title: Install Playwright, add config + fixtures
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Install Playwright, add config + fixtures

Set up the E2E testing infrastructure. After this ticket, `pnpm test:e2e` runs a trivial "app boots" test against a built Electron app with an isolated `$HOME`.

## What to do

1. **Add dev dependency**: `@playwright/test` (latest stable).
   - Run `pnpm add -D @playwright/test`.
   - Do NOT add `playwright-core` separately; the `@playwright/test` package bundles it.
   - Do NOT run `playwright install` for browsers — we only use `_electron`, which ships with the npm package.

2. **Create `playwright.config.ts`** at repo root:
   - `testDir: "./tests/e2e"`
   - `workers: 1` (Electron can't share the daemon socket; must be sequential).
   - `retries: 0` locally.
   - `timeout: 60_000`, `expect.timeout: 10_000` — generous for Electron boot.
   - `reporter: "list"`.
   - `fullyParallel: false`.
   - Do NOT add a browser project — we're using `_electron`.

3. **Create `tests/e2e/fixtures.ts`**:
   - Export a Playwright `test` object extended via `test.extend<{ app: ElectronApplication; window: Page; tempHome: string }>`.
   - For each fixture invocation:
     - Create a temp dir via `fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-"))`.
     - Create a seeded git repo at `<tempHome>/test-project` — `git init`, one commit on `main`. This is so tests that create workspaces have a real project to target. Initial commit can be an empty `.gitkeep`.
     - Launch via `_electron.launch({ args: [path.join(__dirname, "../../dist-electron/main.js")], env: { ...process.env, HOME: tempHome }, cwd: repoRoot })`.
     - Get the first window via `app.firstWindow()`; wait for load state `"domcontentloaded"`.
     - `yield { app, window, tempHome }`.
     - Teardown: `await app.close()`, then `fs.rmSync(tempHome, { recursive: true, force: true })`.
   - Use `import { _electron, type ElectronApplication, type Page } from "@playwright/test"`.

4. **Create `tests/e2e/smoke.spec.ts`** (minimal placeholder for this ticket):
   - Single `test("app boots", ...)` that uses the fixture and asserts `await window.title()` contains "Manor" or the window is visible.
   - This proves the plumbing works. The real smoke flow comes in ticket 3.

5. **Add `test:e2e` script** to `package.json` after `"test:watch"`:
   ```
   "test:e2e": "vite build && playwright test"
   ```
   Keep `"test"` unchanged — vitest stays the default.

6. **Update `.gitignore`** (if present) to include:
   - `test-results/`
   - `playwright-report/`
   - `.playwright/`

7. **Create `tests/e2e/README.md`** with a short "how to run" paragraph and a note that `data-testid` is the preferred selector strategy. Keep it under 30 lines.

## Files to touch

- `package.json` — add devDependency, add `test:e2e` script.
- `playwright.config.ts` — new file at repo root.
- `tests/e2e/fixtures.ts` — new file.
- `tests/e2e/smoke.spec.ts` — new file (placeholder test).
- `tests/e2e/README.md` — new file.
- `.gitignore` — add Playwright output dirs.

## Verification

- `pnpm install` succeeds.
- `pnpm test:e2e` passes the placeholder smoke test end-to-end.
- `pnpm test` (vitest) still passes — no regression.
- Temp `$HOME` dir is cleaned up after test run (check `/tmp` has no leftover `manor-e2e-*` dirs).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-128): Install Playwright, add config + fixtures"

Do not push.
