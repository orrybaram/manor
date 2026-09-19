---
title: E2E — a PC browser opens the app, sees the sidebar, drives a live terminal
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2, 3, 4, 5, 6]
---

# E2E — a PC browser opens the app, sees the sidebar, drives a live terminal

The slice-1 tracer bullet, proven end to end through the real listener, the
real bundle and the real daemon. Follow `tests/e2e/remote-control.spec.ts`'s
discipline exactly: nothing reaches inside the app to fabricate state — the
session comes from the fake agent, the token from the pairing dialog, and the
browser is an ordinary Playwright page holding an address and a bearer token.

## Helpers

- `tests/e2e/helpers/settings.ts` — `pairDevice` takes a capability (default
  `read`, keep existing callers green).
- `tests/e2e/helpers/phone.ts` — generalise `openPhoneClient` into
  `openClient(page, url, { viewport })`; keep `openPhoneClient` as the 390×844
  wrapper and add `openWebApp` at 1280×800 hitting `/app#token`.

## Spec `tests/e2e/web-app.spec.ts`

1. **Pairs at full and boots.** Enable remote control, pair "PC browser" at
   `full`, open the pairing URL with `/app` in place of `/`. Assert the sidebar
   shows the seeded project (`importSeededProject`) and the workspace created
   with `createWorkspace`.
2. **A live terminal, driven from the browser.** With the desktop already
   running the fake agent in a terminal tab (`bootWorkspaceWithTerminal`,
   `FAKE_AGENT_BANNER`), select that pane in the browser and assert the banner
   is visible in the browser's xterm. Type `FAKE_AGENT_ECHO` text into it and
   assert the echo appears in **both** the browser page and the desktop
   window.
3. **The desktop owns the winsize.** Before opening the browser, read the
   session's `cols` via `readSession` from `helpers/local-api.ts`. Set the
   browser viewport to 700×800, wait for the settle window
   (`useTerminalResize`'s 400 ms plus margin), read `cols` again — unchanged.
   Assert the browser's terminal element shows the follower affordance and a
   `font-size` within `[6px, 12px]`.
4. **A send device is refused.** Pair a second device at `send`; open `/app`
   with its token; assert the "not paired with full access" screen (ticket 4's
   `4403` path) and that no session list renders.
5. **Audit.** After steps 2–3, the audit log (whichever the existing tests
   read) has no line for keystrokes (`pty.write` is not audited) and exactly
   the bridge-invoke lines for `pty.create`.

Add `test:e2e:web` and `e2e:web` scripts mirroring the `:remote` ones.

## Files to touch
- `tests/e2e/web-app.spec.ts` — new
- `tests/e2e/helpers/settings.ts` — `pairDevice` capability
- `tests/e2e/helpers/phone.ts` — `openClient` / `openWebApp`
- `package.json` — scripts
