---
title: E2E keyboard navigation suite (red first)
status: in-progress
priority: critical
assignee: opus
blocked_by: []
---

# E2E keyboard navigation suite (red first)

Write `tests/e2e/keyboard-navigation.spec.ts`. It is the spec for the rest of
this ADR, so it **will fail** against the current app. That is expected; do
not change app code in this ticket beyond adding `data-testid`s listed below.

Rules for the spec:
- After boot (`bootWorkspaceWithTerminal`, which may click the import button —
  that is setup, not under test), **no `click()`**. Only `keyboard.press` /
  `keyboard.type`.
- Import `test`/`expect` from `./fixtures`. Read `tests/e2e/README.md` and
  `tests/e2e/sidebar-focus.spec.ts` for style (doc comment per test, polled
  focus assertions via `document.activeElement`).
- Helpers at top: `focusRegion(window)` → `activeElement.closest('[data-focus-region]')?.dataset.focusRegion`;
  `terminalFocused(window)`; `hasVisibleFocus(window)` (outline-style not
  `none` or box-shadow not `none` on the active element).
- Use `test.describe` groups; one app per test is fine (fixtures are
  per-test).

Selector contract (implementation tickets must honour these):
- `[data-focus-region="sidebar|tabbar|pane|statusbar"]` on region roots
- `data-testid="project-header"` on the focusable project header
- `data-testid="home-row"` (exists), `workspace-item` (exists, `aria-current="true"` when active)
- `role="tablist"` / `role="tab"` with `aria-selected`, `data-testid="tab"` (exists)
- `data-testid="tab-close"` on a tab's close button, `aria-label="New tab"` on "+"
- `data-testid="settings-nav-<section>"` on every settings nav button (only `remote` exists)
- `[role="menu"]` for open Radix context menus (Radix default)

Tests to write:
1. **Regions** — from the terminal, F6 → region `sidebar`; F6 → `tabbar`;
   F6 → terminal focused; Shift+F6 → `tabbar`. Status bar is included in the
   cycle when it has focusables (assert cycle returns to pane within 5 presses).
2. **Direct region keys** — Meta+Shift+E focuses the active `workspace-item`;
   Meta+Shift+Y focuses the tab with `aria-selected="true"`. Both work with
   the sidebar hidden via Meta+\ (sidebar re-opens).
3. **Sidebar navigation** — from the active row, ArrowUp reaches
   `project-header`, then `home-row`. End/Home jump. Tab from a row leaves
   the sidebar region (single tab stop).
4. **Enter opens, F2 renames** — Enter on the non-active workspace row makes
   it `aria-current`, and `workspace-name-input` is NOT visible. F2 shows the
   input; Escape cancels; focus returns to the row. Meta+T while the rename
   input is open still opens a tab (shortcuts not swallowed).
5. **Project collapse** — ArrowLeft on `project-header` hides its
   `workspace-item`s; ArrowRight shows them; Enter toggles.
6. **Home row** — Enter on `home-row` shows the home view (pick an existing
   visible marker of the home view; add a `data-testid="home-view"` if none).
7. **Context menu by keyboard** — Shift+F10 on a workspace row opens
   `[role="menu"]`; ArrowDown moves highlight; Escape closes and focus is back
   on the row. Same with Meta+Period on a tab.
8. **Tab bar** — open a second tab (Meta+T). Meta+Shift+Y, ArrowLeft moves
   focus to the other tab without selecting it; Enter selects it
   (`aria-selected`). Tab reaches `tab-close`; Enter closes that tab (count
   drops).
9. **Settings** — Meta+, opens `settings-modal`; Tab reaches
   `settings-nav-appearance`; Enter shows the Appearance section
   (`[data-settings-section]` content changes); Meta+T while open does not
   add a tab; Escape closes and the terminal has focus again.
10. **Focus restore to origin** — focus a sidebar row, Meta+K, Escape → focus
    is back on the same row (not the terminal).
11. **Palette reaches areas** — Meta+K, type "Settings: Appearance", Enter →
    settings open on Appearance. Meta+K, "View All Agents", Enter →
    `agents-modal` visible; Escape closes.
12. **Notifications** — reach `notifications-bell` via F6/Tab from the
    sidebar region, Enter opens `notifications-popover`, Escape closes, focus
    on bell.
13. **New workspace, keyboard only** — Meta+Shift+N, type name, Enter →
    dialog closes and a new `workspace-item` exists.
14. **Browser pane shortcuts** — Meta+Shift+B opens a browser pane; load
    `about:blank` (Meta+L, type, Enter); focus the guest page via
    `app.evaluate` (`webContents.getAllWebContents()` type `webview`,
    `.focus()`); Meta+K opens the palette; F6 moves focus to a region.
15. **Visible focus** — walk F6 regions and ArrowDown through sidebar rows;
    `hasVisibleFocus` is true at every stop.
16. **No pointer-only controls** — the sweep from the audit probe
    (`tests/e2e/_kbd-audit.spec.ts` `pointerOnly`): no visible element with
    computed `cursor: pointer` that is neither focusable nor inside a
    focusable element (skip children of a pointer parent). Run it on the main
    window, with Settings open, and with the notifications popover open.
    Expect `[]`.

Finally delete `tests/e2e/_kbd-audit.spec.ts` (temporary probe). Run the
suite once (`pnpm exec playwright test tests/e2e/keyboard-navigation.spec.ts`,
build exists in `dist-electron/`) and record which tests fail in the commit
body. Failures are expected; syntax/type errors are not
(`pnpm exec tsc --noEmit -p tsconfig.json` must pass if tests are included,
otherwise just ensure Playwright loads the file).

## Files to touch
- `tests/e2e/keyboard-navigation.spec.ts` — new
- `tests/e2e/_kbd-audit.spec.ts` — delete
- `src/components/sidebar/*`, `src/components/settings/SettingsModal.tsx` — only to add test ids if cheap; otherwise leave for later tickets
