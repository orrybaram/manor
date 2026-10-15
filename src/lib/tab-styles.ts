/**
 * Shared visibility styles for the show/hide layer pattern — one absolutely
 * positioned layer per tab or workspace, all stacked, only one shown.
 *
 * These layers nest: a workspace layer contains panel tab layers. `visibility`
 * is inherited, and an explicit `visible` on a descendant overrides an
 * ancestor's `hidden` — so a visible tab inside a hidden workspace would paint
 * itself back in, and every workspace's selected tab would stack on screen at
 * once. The visible layer therefore inherits rather than asserting `visible`:
 * "be as visible as whatever contains me".
 */

const TAB_BASE_STYLE: React.CSSProperties = {
  display: "flex",
  position: "absolute",
  inset: "0",
  overflow: "hidden",
};

export const TAB_VISIBLE_STYLE: React.CSSProperties = {
  ...TAB_BASE_STYLE,
  visibility: "inherit",
};

export const TAB_HIDDEN_STYLE: React.CSSProperties = {
  ...TAB_BASE_STYLE,
  visibility: "hidden",
};

/**
 * Marks a hidden layer, so what lives inside it can tell — through any number
 * of nested layers — that it is not on screen (#300).
 *
 * xterm pauses painting while its IntersectionObserver reports the terminal
 * off screen, and `visibility: hidden` alone still counts as on screen. So a
 * terminal under a marked layer is translated out of the viewport
 * (`TerminalPane.module.css`): it keeps parsing, so queries are answered and
 * the buffer stays current, keeps its layout box, so no resize reaches the
 * pty, and repaints in full once its layer is shown. Only the terminal moves:
 * a `<webview>` moved off screen with its layer stops being throttled while
 * hidden, so the layers themselves stay put.
 */
export function hiddenLayerAttr(hidden: boolean): {
  "data-hidden-layer"?: "";
} {
  return hidden ? { "data-hidden-layer": "" } : {};
}
