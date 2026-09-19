---
title: Render the screen as a grid, not as reflowed text
status: done
priority: critical
assignee: sonnet
blocked_by: [3, 4]
---

# Render the screen as a grid, not as reflowed text

The bug, in the user's words: the terminal is "garbled" on the phone. The cause
is `white-space: pre-wrap; overflow-wrap: anywhere` in
`src/remote-client/styles.css`, which reflows the daemon's fixed-width grid into
~50 columns of phone. An agent's UI is *drawn* — box borders, diff gutters,
progress lines, permission prompts — so every reflowed line breaks in a different
place and the alignment that carries the meaning is gone.

Stop reflowing, and fit the grid to the width by scaling the font instead.
ADR-161's original reasoning ("text hidden off the right edge is text nobody
reads") is answered by the fit, not by wrapping.

## The render

`src/remote-client/styles.css`, `.terminal .stream`:

- `white-space: pre` and drop `overflow-wrap: anywhere` — a screen row is a row;
- `font-size: var(--term-font-size, 12px)`;
- the `.terminal` scroller gains horizontal scrolling (`overflow: auto` already
  covers both axes — verify it does in practice and that the flex column does not
  clamp the child's width; the `<code>` may need `min-width: max-content`).

`src/remote-client/main.ts` / a small helper in `src/remote-client/ansi.ts`
(wherever it reads better — the measurement is presentation, not parsing):

- keep the grid width from `POST /sessions/read` on the `transcript` state next to
  `text` (ticket 4 added `cols`);
- measure the mono font's per-character advance **once**, lazily: a probe span
  with a known number of `0` characters at a known font size, appended to the
  transcript, measured with `getBoundingClientRect().width`, removed. Cache the
  ratio (advance ÷ font size) — the font never changes;
- `size = floor(available / (cols × ratio))` where `available` is the transcript's
  client width minus its horizontal padding, then clamp:
  - ceiling **12px** — the current size; a narrow grid should not balloon;
  - floor **6px** — below this nobody reads anything, so the floor wins and the
    transcript pans sideways with the alignment intact;
- write the result to `--term-font-size` on the `.terminal` element, so a repaint
  costs one property and never a rebuild;
- `cols === null` (unknown grid, per ticket 4) → leave the size at the 12px
  ceiling; the grid is still not reflowed;
- recompute on `resize` and `orientationchange`, and whenever `cols` changes.
  Debounce or coalesce — a rotation fires several. Do not recompute on every
  transcript poll: the size depends on `cols` and the viewport, neither of which
  a poll changes.

Preserve what `paintTerminal()` already gets right: the stick-to-bottom logic and
the "identical output is not worth re-rendering" check. Changing the font size
changes `scrollHeight`, so apply the size *before* measuring for stickiness, or
the reader's place will jump on the first paint of a new session.

## Comments

The block comment on `.terminal .stream` currently argues for wrapping. Replace
it with the reason it is wrong for a drawn UI, and say what the floor and the
horizontal pan are for — the next person to look at a 6px transcript on a wide
pane needs to find that decision written down.

## Files to touch
- `src/remote-client/styles.css` — `.terminal .stream`, the scroller, the comment
- `src/remote-client/main.ts` — grid width in state, the fit computation, resize handling
- `src/remote-client/ansi.ts` — only if the advance-measurement helper belongs here
