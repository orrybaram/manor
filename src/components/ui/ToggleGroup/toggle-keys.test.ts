import { describe, it, expect } from "vitest";
import { toggleKeyAction } from "./toggle-keys";

describe("toggleKeyAction", () => {
  const enabled = ["a", "b", "c"];

  it("moves and chooses with arrow keys in automatic mode", () => {
    expect(toggleKeyAction("ArrowRight", enabled, "a", "automatic")).toEqual({
      focus: "b",
      choose: true,
    });
    expect(toggleKeyAction("ArrowUp", enabled, "b", "automatic")).toEqual({
      focus: "a",
      choose: true,
    });
  });

  it("only moves focus in manual mode", () => {
    expect(toggleKeyAction("ArrowDown", enabled, "a", "manual")).toEqual({
      focus: "b",
      choose: false,
    });
    expect(toggleKeyAction("End", enabled, "a", "manual")).toEqual({ focus: "c", choose: false });
  });

  it("wraps around the ends and handles Home and End", () => {
    expect(toggleKeyAction("ArrowRight", enabled, "c", "automatic")?.focus).toBe("a");
    expect(toggleKeyAction("ArrowLeft", enabled, "a", "automatic")?.focus).toBe("c");
    expect(toggleKeyAction("Home", enabled, "c", "automatic")?.focus).toBe("a");
  });

  it("steps from the first option when focus isn't on an enabled one", () => {
    expect(toggleKeyAction("ArrowRight", enabled, "disabled", "automatic")?.focus).toBe("b");
    expect(toggleKeyAction("ArrowRight", enabled, undefined, "automatic")?.focus).toBe("b");
  });

  it("ignores other keys, and a group with nothing to choose", () => {
    expect(toggleKeyAction("Enter", enabled, "a", "manual")).toBeNull();
    expect(toggleKeyAction("ArrowRight", [], undefined, "automatic")).toBeNull();
  });
});
