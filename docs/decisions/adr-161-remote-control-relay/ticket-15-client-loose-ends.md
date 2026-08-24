---
title: Client loose ends — cold notification tap, unused routes, transcript depth
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Client loose ends — cold notification tap, unused routes, transcript depth

Four small things, one of which is a security-surface decision rather than a bug.

**A cold notification tap lands on the list.** `src/remote-client/sw.ts` opens
`./?task=<id>` when no window is already open, and `main.ts` never reads `location.search`.
So tapping a push with the app closed — the most likely way anyone will ever open this
client — puts you on the session list instead of the session that needs you. Read the
`task` parameter on startup, open that session, and strip the parameter from the URL the
way the token fragment is already stripped.

**Two allowlisted routes nothing calls.** `GET /panes` and `GET /context` are in
`REMOTE_READ_ROUTES`, and `main.ts` calls neither. Pick one:

- _Use them._ `GET /tasks` only knows about task-backed sessions, so a plain terminal
  left running is invisible from the phone. `GET /panes` would make the phone show
  everything the desk shows.
- _Remove them._ An allowlisted route with no caller is exposure bought for nothing, and
  the allowlist is the part of this feature reviewers are asked to be unsympathetic
  about.

Either is defensible; leaving it undecided is not. If they are removed, the allowlist
tests come with them.

**The transcript is a fixed tail.** `loadTranscript` asks for `tailLines: 400` with no way
to go further back. A long agent run is truncated with no indication that anything was
cut. Add a "load earlier" affordance that re-reads with a larger tail, and say when the
view is truncated rather than letting it look complete.

**No filter on the session list.** Fine with four sessions, poor with twenty. The list
already sorts blocked-first; a filter field and/or a "needs attention only" toggle is the
cheap version. Keep it client-side — the data is already there.

Tests: a `?task=` on load opens that session and clears the parameter; the allowlist test
matches whichever decision is taken above; "load earlier" requests a larger tail and
preserves scroll position through `paintTerminal`.

## Files to touch

- `src/remote-client/main.ts` — all four.
- `src/remote-client/styles.css` — filter and truncation affordances.
- `electron/remote-control/allowlist.ts` — only if the routes are removed.
- `electron/remote-control/__tests__/allowlist.test.ts` — likewise.
