---
title: E2E — a phone walks the desk's layout
status: todo
priority: high
assignee: opus
blocked_by: [4, 5, 6, 7, 8]
---

# E2E — a phone walks the desk's layout

## Do not run Playwright

Write the specs; **the orchestrator runs them** and sends back failures. Three
agents on ADR-180 were killed by a 600s silence watchdog running E2E in one
blocking command. You may run `pnpm typecheck`, `pnpm lint`,
`npx vitest run`. Leave the specs in a state you can iterate on.

## Scenarios — `tests/e2e/phone.spec.ts`

Use `openWebApp` / `openClient` from `tests/e2e/helpers/phone.ts` at a
**390 × 844** viewport (it already takes any viewport), paired at `full`.

1. **One pane at a time.** The desk has a workspace with a split tab (two
   panes) and a second tab. On the phone, exactly one pane is visible and it is
   the viewport's focused pane; the top bar, tab strip and no status bar are
   present; no sidebar inline.
2. **The switcher moves, and nothing remounts.** Open the pane switcher, pick
   the other pane of the split: it becomes the visible one. **Assert no
   terminal remounted and no pane was resized** — count `pty.create` calls
   through the audit log or the bridge, and read each pane's grid before and
   after. This is ADR-181 D1's promise; it is the test that matters most.
3. **The drawer.** Open it, pick another workspace: the drawer closes and that
   workspace is shown.
4. **The palette** opens full screen from the top-bar button and a pane action
   (split) run from it lands on the desk's layout too.
5. **Width, not platform.** Drag the *desktop* window narrower than 768 px:
   it switches to phone chrome. A *detached* window below 768 px does not.
6. **No drags on a phone.** A drag gesture on a tab does not start a tab drag.

Keep test ids stable: add `data-testid` to the phone components you assert on
(`phone-top-bar`, `pane-switcher`, `sidebar-drawer`), not class names —
ADR-180 ticket 13 found a spec asserting nothing because a component moved and
took its class names with it.

## Files to touch
- `tests/e2e/phone.spec.ts` — new
- `tests/e2e/helpers/phone.ts` — only if a phone-viewport helper is missing
- the phone components — `data-testid`s only, if tickets 3–6 did not add them
