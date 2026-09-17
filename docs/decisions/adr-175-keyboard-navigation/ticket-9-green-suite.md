---
title: Make the keyboard suite green and run the full e2e suite
status: todo
priority: high
assignee: opus
blocked_by: [3, 4, 5, 6, 7, 8]
---

# Make the keyboard suite green and run the full e2e suite

1. `pnpm build`, then `pnpm exec playwright test tests/e2e/keyboard-navigation.spec.ts`.
2. For each failure decide: app bug (fix in app) or test bug (fix test —
   never weaken the "no click" rule or the pointer-only sweep). Loosen a
   test only if the ADR explicitly scopes that behaviour out.
3. Run the full e2e suite (`pnpm exec playwright test`) and `pnpm test`,
   `pnpm lint`, typecheck. Fix regressions caused by this ADR (e.g. specs
   that relied on Enter-to-rename or on clicking a tab div).
4. Update `tests/e2e/README.md` with a short "Keyboard navigation" section:
   the selector contract (`data-focus-region`, etc.) and the pointer-only
   sweep.
5. Document user-facing keys (F6, ⌘⇧E, ⌘⇧Y, F2, Shift+F10 / ⌘.) wherever
   shortcuts are documented, and in `CHANGELOG.md` if it has an Unreleased
   section.

## Files to touch
- whatever the failures point at
- `tests/e2e/README.md`, docs, `CHANGELOG.md`

## Known flake to resolve

`sidebar › project headers collapse from the keyboard` failed 2/3 runs after ticket 4 (also on the pre-ticket-4 baseline). ArrowUp timing in the sidebar. Find the root cause (likely a roving-tabindex / focus race in `installRovingRows` or the collapse re-render dropping focus) — fix the app, not the wait.

Also intermittently failing under `--repeat-each` since ticket 3: `Enter opens a workspace, F2 renames it` and `Enter on Home opens the home view`. Same suspicion: sidebar focus lost across a re-render. Run each with `--repeat-each 10` before and after the fix.

## Other failing specs to triage

- `command-palette-frequent.spec.ts` › frequently used commands rise to the top
- `notification-center.spec.ts` › a suppressed notification is still recorded, readable, and clickable

Both fail on the commit before ticket 6. Decide whether ADR-175 caused them: check out `7708dc9` (pre-ADR main) in a temporary git worktree, copy in the current `tests/e2e/fixtures.ts` (PATH shim fix), build, and run both. If they fail there too, report them as pre-existing and leave them alone. If they pass, fix the regression.
