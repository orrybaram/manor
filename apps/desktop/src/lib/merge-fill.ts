/** How long the fill takes to reach halfway; the rest of the bar takes ever longer. */
const HALFWAY_MS = 450;

/**
 * How full the Merge button is, 0 to 1, this long into a merge. `gh pr merge`
 * gives no progress and can take any time, so the fill is quick at first and
 * keeps creeping for as long as the wait lasts. It never arrives on its own:
 * only the merge's answer fills the button.
 */
export function mergeFillAt(elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  return elapsed / (elapsed + HALFWAY_MS);
}
