import { describe, expect, it } from "vitest";
import { floorColors } from "./floor-renderer";

const style = (vars: Record<string, string>) => ({
  getPropertyValue: (name: string) => vars[name] ?? "",
});

describe("floorColors", () => {
  it("follows the theme's CSS variables as the app paints them", () => {
    expect(floorColors(style({ "--fg": " #cdd6f4", "--yellow": "#f9e2af " }))).toEqual({
      dot: "#cdd6f4",
      gold: "#f9e2af",
    });
    // A light theme's foreground replaces the dark one.
    expect(floorColors(style({ "--fg": "#4c4f69", "--yellow": "#df8e1d" })).dot).toBe("#4c4f69");
  });

  it("has a fallback before the theme lands", () => {
    expect(floorColors(style({}))).toEqual({ dot: "#e9e3d3", gold: "#ffe800" });
  });
});
