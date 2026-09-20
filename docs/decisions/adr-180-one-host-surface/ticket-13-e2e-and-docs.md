---
title: E2E, docs and the vocabulary
status: todo
priority: high
assignee: sonnet
blocked_by: [12]
---

# E2E, docs and the vocabulary

ADR-180's closing ticket: prove the desktop still is the desktop, and write
down what changed for the people who read the docs instead of the diff.

## E2E

The existing desktop suite is the real assertion here — every spec in
`tests/e2e/` now exercises the bridge, because there is no other path. Run it
unattended (see `1f2fa68`). Beyond that, add to `tests/e2e/web-app.spec.ts` or
a sibling:

- **A desktop window and a browser on one pane.** The desktop owns the
  winsize; the browser follows; close the desktop tab and the browser is told
  it now owns it (`pty.winsizeOwner`), which ADR-179 D6 built and this slice
  makes reachable from the desktop side too.
- **Two desktop windows on one pane** (the primary and a detached window
  claiming the tab): the more recent attach owns the winsize and the other
  follows, rather than the two fighting. This is D6's repair and it has no
  test today.
- **A `full` device is refused a `LOCAL_ONLY` method.** `remoteControl.pair`
  over the bridge comes back `unavailable:web` and leaves the device list
  unchanged.
- **The CLI with the window closed.** `manor split-pane` and a `menu-command`
  still land, which is ticket 4's addressed-event path.

## Docs

- `docs/remote-control.md` — the `full` tier section gains `LOCAL_ONLY`: name
  the five `remoteControl` methods and the keybinding writes a paired device
  cannot reach, and say why (a token that can pair survives its own
  revocation). Keep the doc's habit of stating what is absent rather than
  implying it.
- `docs/agents/domain.md` — the bridge is no longer "IPC inside Electron,
  HTTP/WebSocket from a browser, converging on the latter"; it is one table
  with two transports.
- `CONTEXT.md` — **Bridge** is reworded to match; add **Host surface** (the
  handler table: the one set of things a renderer can ask a host to do),
  **Transport** (how frames get there — Electron IPC or a WebSocket — never a
  place where behaviour lives) and **Caller class** (`local` or `device`).
  Keep the `_Avoid_` lines in the file's existing style.
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md` — amend D8 and
  its Consequences: the desktop does not dial a loopback socket; the recorded
  "first paint will one day wait on a localhost socket" is superseded by
  ADR-180 D2. Link ADR-180 from D10's slice list as slice 3, the way slice 2
  links ADR-179.

## Files to touch
- `tests/e2e/web-app.spec.ts` — the four scenarios above (or a new `bridge.spec.ts`)
- `docs/remote-control.md` — the `LOCAL_ONLY` paragraph
- `docs/agents/domain.md` — the bridge's new shape
- `CONTEXT.md` — Bridge reworded; Host surface, Transport, Caller class added
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md` — D8/D10 amendment
