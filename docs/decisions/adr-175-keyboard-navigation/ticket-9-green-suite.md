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
