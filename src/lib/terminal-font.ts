/**
 * The terminal's fonts, in memory before anything measures a cell.
 *
 * xterm sizes its grid by dividing the pane's box by one cell, and it measures
 * that cell from whatever font the browser can draw *at that moment*. The
 * terminal font here is a webfont (see the `@font-face` rules in `App.css`),
 * so a pane that opens before the file has arrived measures the fallback
 * instead: 15px per row where the real font is 17.
 *
 * Nothing corrects that on its own. The mismeasured size is what the pty is
 * told and what the pane keeps, so the grid sits six rows taller than the box
 * it lives in — bottom rows clipped — until something else moves it. The first
 * window drag is usually what does, and by then the damage is worse than a
 * clipped pane: xterm re-measures its cell when the grid changes, so the first
 * fit of that drag is still computed at 15px and asks the pty for a size the
 * pane never was. The correction lands ~10ms later, but a program that
 * repaints on `SIGWINCH` has already redrawn its whole screen for the phantom
 * size, and every row that overflowed is scrolled off where no later repaint
 * can erase it. That is the duplication in issue #169.
 *
 * So the fonts are loaded before the app renders. They are bundled files, so
 * this is a few milliseconds at startup, and it removes the race rather than
 * correcting after it: a re-fit *is* a `SIGWINCH`, and the whole point is not
 * to send one.
 */

/**
 * How long the first paint waits on fonts.
 *
 * The fallback is a perfectly measurable font — it is what the pane would be
 * drawn with anyway — so a font that never settles must cost a mismeasured
 * pane, not a blank window. Long enough that a local file never races it.
 */
const FONT_TIMEOUT_MS = 2_000;

/**
 * Resolve once the terminal's fonts can be measured, or when waiting longer
 * stops being worth a blank window.
 *
 * The set is read from `document.fonts` rather than a list kept here: every
 * `@font-face` the stylesheet declares is in it by the time this runs, so a
 * font added to the CSS is covered without anyone remembering this file. A
 * list here would be a second place to keep the same truth, which is exactly
 * the shape of the bug this exists to fix.
 */
export async function loadTerminalFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loaded = Promise.all(
    [...document.fonts].map((face) =>
      face.load().catch(() => {
        // A font file that fails to load leaves the fallback in place, which
        // is measurable. Only a *pending* one is the problem.
      }),
    ),
  );
  await Promise.race([
    loaded,
    new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS)),
  ]);
}
