/** Shared visibility styles for tab content show/hide pattern. */

const TAB_BASE_STYLE: React.CSSProperties = {
  display: "flex",
  position: "absolute",
  inset: "0",
  overflow: "hidden",
};

export const TAB_VISIBLE_STYLE: React.CSSProperties = {
  ...TAB_BASE_STYLE,
  visibility: "visible",
};

export const TAB_HIDDEN_STYLE: React.CSSProperties = {
  ...TAB_BASE_STYLE,
  visibility: "hidden",
};
