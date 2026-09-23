---
title: Test helper dedupe and changelog-comment pruning
status: done
priority: low
assignee: haiku
blocked_by: [13]
---

# Test helper dedupe and changelog-comment pruning

## Test helpers
- **Menu-click walker.** Import `clickMenuItem` from `tests/e2e/helpers/window.ts` in `app-menu.spec.ts`, `keyboard-navigation.spec.ts` and `detach.spec.ts`, and delete their local copies.
- **`Phone` alias.** Delete `export type Phone = Client` from `tests/e2e/helpers/phone.ts` and rename its users to `Client`.
- **Settle window.** Export the settle-window constant (400ms) from `src/hooks/useTerminalResize.ts`, or wherever it lives after ticket 1. Use it for the magic sleeps in `web-app.spec.ts:~332,514`, `bridge.spec.ts:~177` and `phone.spec.ts:~446`.

## Comments
- In `electron/bridge/**`, `src/bridge/**`, `src/lib/layout/**`, `electron/app-lifecycle.ts` and `electron/layout/layout-store.ts`, delete comments that narrate history ("used to", "ticket N", "slice-1", "went with ticket 15") or are no longer true.
- Keep comments that explain a current *why*. Do not change code.

## Files to touch
- `tests/e2e/*.spec.ts`, `tests/e2e/helpers/*`, `src/hooks/useTerminalResize.ts` (the export only)
- comment-only edits in the files listed above
