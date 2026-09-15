type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Styles that affect where text lands inside the field. */
const MIRRORED_PROPERTIES = [
  "direction",
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

/**
 * Viewport rect of the character at `index` inside an input or textarea.
 *
 * Fields do not expose caret geometry, so this lays the text out again in a
 * hidden div styled like the field, sitting exactly on top of it, and
 * measures a marker span at `index`. The result is clamped to the field so a
 * position scrolled out of view still anchors to its visible edge.
 *
 * A single-line input vertically centres its text, which the mirror does not
 * reproduce, so inputs only take the horizontal position and keep the field's
 * own top and height.
 */
export function getCaretClientRect(el: TextField, index: number): DOMRect {
  const fieldRect = el.getBoundingClientRect();
  const isInput = el instanceof HTMLInputElement;
  const computed = window.getComputedStyle(el);

  const mirror = document.createElement("div");
  const style = mirror.style;
  for (const property of MIRRORED_PROPERTIES) {
    style[property] = computed[property];
  }
  style.position = "fixed";
  style.top = `${fieldRect.top}px`;
  style.left = `${fieldRect.left}px`;
  style.visibility = "hidden";
  style.pointerEvents = "none";
  style.whiteSpace = isInput ? "pre" : "pre-wrap";
  style.overflowWrap = isInput ? "normal" : "break-word";

  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  // The marker needs width-bearing content to get a real line box.
  marker.textContent = el.value.slice(index, index + 1) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);

  const left = clamp(
    markerRect.left - el.scrollLeft,
    fieldRect.left,
    fieldRect.right,
  );
  if (isInput) {
    return new DOMRect(left, fieldRect.top, 0, fieldRect.height);
  }
  const top = clamp(
    markerRect.top - el.scrollTop,
    fieldRect.top,
    fieldRect.bottom - markerRect.height,
  );
  return new DOMRect(left, top, 0, markerRect.height);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
