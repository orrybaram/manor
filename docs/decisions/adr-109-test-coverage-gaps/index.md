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

# ADR-109: Close Critical Test Coverage Gaps

## Context

An audit found ~25 test files covering ~164 source files (~15% file coverage). The electron terminal-host subsystem is well-tested, but several critical areas have zero tests:

- **`electron/ipc-validate.ts`** — Input validation helpers used by every IPC handler, 0 tests
- **`electron/github.ts`** — GitHubManager class (PR lookup, issue CRUD, auth status, image upload), 0 tests
- **`electron/linear.ts`** — LinearManager class (token management, GraphQL client, issue operations, auto-match), 0 tests
- **`electron/theme.ts`** — ThemeManager + Ghostty config parsing, 0 tests
- **`src/store/app-store.ts`** — 75KB core Zustand store with 40+ actions (tab/pane/panel CRUD, layout restore, workspace management), 0 dedicated tests

No coverage thresholds or reporting are configured in vitest.

## Decision

Add test suites for the five highest-risk untested modules, following existing project patterns (colocated `*.test.ts` files, vitest, `vi.mock` for external deps, temp dirs for filesystem tests, local helper functions).

**Ticket breakdown:**

1. **ipc-validate.ts** — Straightforward assertion functions. Test all type guards and error messages.
2. **theme.ts** — Pure parsing functions (`parseGhosttyFile`, `buildTheme`, `loadThemeFromConfig`) are testable without filesystem mocks. ThemeManager methods need fs mocks.
3. **github.ts** — Mock `execFile` to test GitHubManager methods: PR parsing with checks summary, issue listing, auth status detection, error handling (gh not installed, not authenticated, command failures).
4. **linear.ts** — Mock `fetch` and `safeStorage` to test LinearManager: token CRUD, GraphQL client error handling, issue sorting logic, `autoMatchProjects` (pure function).
5. **app-store.ts** — Test Zustand store actions: tab CRUD, pane split/close/reopen, panel operations, layout restore from v1/v2 formats, workspace management. Use `useAppStore.setState()` for setup per existing patterns.

## Consequences

**Better:** Catches regressions in validation, theming, external API integrations, and core UI state management. Establishes coverage for the most-touched files.

**Neutral:** No architectural changes — just new test files alongside existing source.

**Risk:** Some tests mock heavily (execFile, fetch, fs, safeStorage). If implementations change, mocks need updating. Mitigation: test behavior and return values, not implementation details.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
