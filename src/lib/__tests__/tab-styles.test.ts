import { describe, expect, it } from "vitest";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../tab-styles";

describe("tab-styles", () => {
  it("moves a hidden layer off screen without changing its box", () => {
    // Off screen to IntersectionObserver, so xterm pauses painting (#300).
    expect(TAB_HIDDEN_STYLE.transform).toBe("translateX(-200vw)");
    expect(TAB_VISIBLE_STYLE.transform).toBeUndefined();
    // Same layout box either way: hiding must never resize the pty.
    const box = ({ display, position, inset, overflow }: React.CSSProperties) =>
      ({ display, position, inset, overflow });
    expect(box(TAB_HIDDEN_STYLE)).toEqual(box(TAB_VISIBLE_STYLE));
  });

  it("hides with visibility, and shows by inheriting it", () => {
    expect(TAB_HIDDEN_STYLE.visibility).toBe("hidden");
    expect(TAB_VISIBLE_STYLE.visibility).toBe("inherit");
  });
});
