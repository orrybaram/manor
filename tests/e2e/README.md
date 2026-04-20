# E2E Tests (Playwright)

This directory contains end-to-end tests for Manor using [Playwright](https://playwright.dev/) with the `_electron` launcher.

## How to run

```bash
# Build the app and run all E2E tests
pnpm test:e2e

# Run a specific test file
pnpm dlx playwright test tests/e2e/smoke.spec.ts
```

The `pnpm test:e2e` command runs `vite build` first to ensure `dist-electron/main.js` is up to date before launching Electron.

## Fixtures

Import `test` and `expect` from `./fixtures` (not directly from `@playwright/test`). The custom fixture provides:

- `app` — the running `ElectronApplication` instance.
- `window` — the first `Page` (renderer window), already loaded.
- `tempHome` — path to an isolated temporary `$HOME` dir with a seeded git repo at `<tempHome>/test-project`. The dir is cleaned up automatically after each test.

## Selector strategy

Use `data-testid` attributes as the primary selector. Prefer:

```ts
window.getByTestId("my-component")
```

over CSS selectors or text-based selectors whenever possible.
