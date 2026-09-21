---
title: Docs and the record
status: todo
priority: medium
assignee: sonnet
blocked_by: [9]
---

# Docs and the record

- **`CONTEXT.md`** — add **Layout mode** (`phone` / `desk`: a presentation of
  the viewport, chosen by width, never by platform; a detached window is always
  `desk`). Match the file's `_Avoid_:` style (e.g. avoid "mobile mode",
  "responsive view").
- **`docs/remote-control.md`** — the web app on a phone: what you see, how you
  move (tab strip, switcher, drawer, palette), and the stated limitation from
  ADR-181 D6 — **a phone keyboard has no Esc, Tab or Ctrl, so a phone cannot
  interrupt an agent or answer a TUI prompt that needs them.** Say it plainly;
  it is a decision, not a bug.
- **`docs/decisions/adr-178-web-app-and-single-bridge/index.md`** — D9 and D10:
  link ADR-181 as slice 4, the way slices 2 and 3 link ADR-179 and ADR-180.
  Note D9's two departures — no swipe (ADR-181 D4), and the native keyboard
  rather than a phone-specific input (D6).
- **`docs/decisions/adr-181-phone-layout/index.md`** — make the record match
  what shipped: anything the tickets' reports changed, and what ticket 7 could
  only verify on a real device. Leave `status: proposed`; the orchestrator
  flips it. You may edit these two ADR files only.
- **`tests/e2e/README.md`** — add `phone.spec.ts`.

## Files to touch
- `CONTEXT.md`
- `docs/remote-control.md`
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md`
- `docs/decisions/adr-181-phone-layout/index.md`
- `tests/e2e/README.md`
