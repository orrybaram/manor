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
 * A small pill naming the host a tab's workspace runs on (ADR-160 ticket 11
 * §5). Shown only for a remote workspace — a local one gets no badge at all,
 * so this costs nothing in the overwhelmingly common case.
 */
export const REMOTE_HOST_BADGE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 9,
  lineHeight: 1,
  padding: "1px 4px",
  borderRadius: 3,
  marginLeft: 4,
  whiteSpace: "nowrap",
  flexShrink: 0,
};
