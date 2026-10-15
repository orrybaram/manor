import { describe, expect, it } from "vitest";
import {
  TAB_HIDDEN_STYLE,
  TAB_VISIBLE_STYLE,
  hiddenLayerAttr,
} from "../tab-styles";

describe("tab-styles", () => {
  it("keeps the same layout box hidden or shown", () => {
    // Hiding must never resize a pane, and so never resize its pty.
    const box = ({ display, position, inset, overflow }: React.CSSProperties) =>
      ({ display, position, inset, overflow });
    expect(box(TAB_HIDDEN_STYLE)).toEqual(box(TAB_VISIBLE_STYLE));
  });

  it("never moves the layer itself", () => {
    // Only terminals under a hidden layer move off screen (#300); a webview
    // moved with its layer would stop being throttled while hidden.
    expect(TAB_HIDDEN_STYLE.transform).toBeUndefined();
    expect(TAB_VISIBLE_STYLE.transform).toBeUndefined();
  });

  it("hides with visibility, and shows by inheriting it", () => {
    expect(TAB_HIDDEN_STYLE.visibility).toBe("hidden");
    expect(TAB_VISIBLE_STYLE.visibility).toBe("inherit");
  });

  it("marks only a hidden layer", () => {
    expect(hiddenLayerAttr(true)).toEqual({ "data-hidden-layer": "" });
    expect(hiddenLayerAttr(false)).toEqual({});
  });
});
