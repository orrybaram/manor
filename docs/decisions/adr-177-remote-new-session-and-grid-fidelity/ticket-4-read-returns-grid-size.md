---
title: POST /sessions/read reports the grid it rendered
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# POST /sessions/read reports the grid it rendered

The client cannot lay out a terminal screen it does not know the width of, and
the longest line in a tail is not the column count. Return the grid size with the
text.

`electron/routes/agents.ts`, the `POST /sessions/read` handler: add `cols` and
`rows` to the 200 payload, alongside `source`, `text`, `lineCount` and
`truncated`.

- Live path — the snapshot already carries them: `TerminalSnapshot` has `cols`
  and `rows` (`electron/terminal-host/types.ts`).
- Cold path — `ScrollbackWriter.readMeta(paneId)` returns `SessionMeta`, which
  has `cols` and `rows` (`electron/terminal-host/scrollback.ts`). The handler
  already calls `readMeta` in the not-found check; read it once and reuse it
  rather than calling twice.
- Neither available (a scrollback dir with unreadable meta) → `cols: null`,
  `rows: null`. Do not invent 80; a client that gets null must be able to tell
  that it is guessing, and ticket 5 falls back accordingly.

Additive only — no existing field changes and no existing caller needs touching.
Extend the handler's comment to say why a *renderer* needs the grid size, so the
fields do not look decorative.

## Tests

`electron/routes/agents-read.test.ts` already builds a fake `getSnapshot` and
exercises both paths:

- live snapshot → `cols`/`rows` are the snapshot's;
- scrollback path → they come from `meta.json`;
- unreadable/absent meta → both `null`;
- they are unaffected by `tailLines`/`maxBytes` truncation (the grid is the
  grid, however much of it was returned).

## Files to touch
- `electron/routes/agents.ts` — the `/sessions/read` payload and its comment
- `electron/routes/agents-read.test.ts` — the four assertions above
