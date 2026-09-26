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
