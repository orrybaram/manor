---
title: E2E — a phone-sized screen renders row for row, and can launch
status: done
priority: high
assignee: sonnet
blocked_by: [3, 5]
---

# E2E — a phone-sized screen renders row for row, and can launch

`tests/e2e/remote-control.spec.ts` already drives the real client through the
real listener on a 390×844 viewport (`tests/e2e/helpers/phone.ts`). Both of
ADR-177's claims are measurable there, so neither rests on having looked at it
once.

Read the spec's header comment and keep its discipline: nothing reaches inside
the app to fabricate state — the session comes from the fake agent reporting its
own lifecycle, the token from the pairing dialog, and the client is an ordinary
browser page holding an address and a bearer token.

## 1. The grid is not reflowed

Have the session draw something wider than the phone — a box-drawing frame or a
ruler line wider than the viewport, via the fake-agent helpers in
`tests/e2e/helpers/fake-agent.ts` and `runInTerminal`. Then, in the phone page:

- read the transcript the client was served (`POST /sessions/read` via
  `tests/e2e/helpers/local-api.ts`'s `readSession`, or intercept what the page
  fetched) and count its lines;
- in the page, measure the rendered `.terminal .stream`: its visual row count is
  `scrollHeight / lineHeightPx` (read the computed line-height; do not hardcode
  1.45 × 12);
- assert rendered rows === payload lines. **A reflow is exactly the failure this
  catches**: wrapping a 120-column grid into a 390px phone produces more visual
  rows than lines, and this assertion goes red;
- assert the drawn box's own characters are still column-aligned by checking the
  rendered text of two frame rows have equal length — the cheap, direct version
  of "perfectly replicated output";
- assert the computed `font-size` is ≤ 12px and ≥ 6px (the ticket-5 clamp), and
  that `white-space` is `pre`.

## 2. Launching from the phone

A send-capable paired device, on the list screen:

- the `+` control is present; a read-only device does not get one (extend the
  existing read-only test rather than writing a parallel one if that reads
  better);
- tap `+` → the workspace list shows the seeded project (`PROJECT_NAME`) and a
  workspace created with the `createWorkspace` fixture;
- select it, type a prompt, tap Launch, confirm the sheet;
- assert a new session appears — `waitForVisibleSession` / `sessionRow` from the
  existing helpers — and that the client ends up on a transcript screen rather
  than a dead one;
- assert the audit log recorded the launch (the settings audit UI, or the audit
  file, whichever the existing tests already use) with the workspace as its
  target and no prompt text in it.

Reuse `pairedPhone`, `Filmstrip`, and the settings helpers. Do not add a new
browser context where the existing fixture fits.

## Files to touch
- `tests/e2e/remote-control.spec.ts` — the two new cases
- `tests/e2e/helpers/phone.ts` — only if a locator or a measurement helper belongs there
- `tests/e2e/helpers/fake-agent.ts` — only if the wide-output fixture needs a new banner
