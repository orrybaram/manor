---
title: Docs — read-and-type is over; ADR-156/157/152/178 amended
status: todo
priority: medium
assignee: sonnet
blocked_by: [8]
---

# Docs — read-and-type is over; ADR-156/157/152/178 amended

- `docs/remote-control.md` — "The web app" section: replace the read-and-type
  paragraph with what a `full` browser can now do (arrange: split, tabs, pin,
  close; sees every tab including detached ones); note that selection is per
  device; keep the native-only list.
- `docs/decisions/adr-156-detach-tab-to-window/index.md`,
  `adr-157-detach-pane-to-window/index.md` — one-line "Amended by ADR-179:
  detached windows are viewport claims; the hand-off payload is gone" under
  the H1, in the house style.
- `adr-152-mcp-pane-tools-correctness/index.md` — "Amended by ADR-179:
  structural pane tools no longer round-trip through a window."
- `adr-178-web-app-and-single-bridge/index.md` — under D10, a line noting
  slice 2 landed as ADR-179; strike the "Known gaps after slice 1" paragraph
  or mark it resolved.
- `CONTEXT.md` — read it against the code as landed: **Viewport**, **Claim**,
  **Detached window**, **Layout command**, **Default viewport** must match
  what shipped. Adjust wording only; do not add implementation detail.
- `electron/layout/layout-store.ts` and `src/lib/layout/commands.ts` module
  docstrings say what they own and cite ADR-179.

## Files to touch
- `docs/remote-control.md`
- `docs/decisions/adr-15{2,6,7}-*/index.md`, `docs/decisions/adr-178-*/index.md`
- `CONTEXT.md`
- module docstrings named above
