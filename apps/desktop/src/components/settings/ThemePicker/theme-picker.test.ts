import { describe, expect, it } from "vitest";
import type { ThemeCatalog, ThemeListEntry } from "../../../../electron/theme";
import { copyName, filterCounts, gridMove, visibleThemes } from "./theme-picker";

function entry(
  name: string,
  scheme: "dark" | "light",
  source: ThemeListEntry["source"] = "ghostty",
): ThemeListEntry {
  const background = scheme === "dark" ? "#111111" : "#fafafa";
  return {
    name,
    displayName: name.replace(/^custom:/, ""),
    source,
    scheme,
    colors: {
      background,
      foreground: "#888888",
      red: "#ff0000",
      green: "#00ff00",
      yellow: "#ffff00",
      blue: "#0000ff",
      magenta: "#ff00ff",
      cyan: "#00ffff",
    },
  };
}

const catalog: ThemeCatalog = {
  themes: [
    entry("__default__", "dark", "builtin"),
    entry("__manor__", "dark", "builtin"),
    entry("custom:Paper", "light", "custom"),
    entry("Dracula", "dark"),
    entry("GitHub Light", "light"),
  ],
  recent: ["Dracula", "__manor__"],
};
const names = (list: ThemeListEntry[]) => list.map((t) => t.name);

describe("visibleThemes", () => {
  it("All keeps catalog order", () => {
    expect(names(visibleThemes(catalog, "all", ""))).toEqual(catalog.themes.map((t) => t.name));
  });

  it("Dark and Light split by background", () => {
    expect(names(visibleThemes(catalog, "light", ""))).toEqual(["custom:Paper", "GitHub Light"]);
    expect(names(visibleThemes(catalog, "dark", ""))).toEqual(["__default__", "__manor__", "Dracula"]);
  });

  it("Recent keeps newest-first order; Yours shows only custom themes", () => {
    expect(names(visibleThemes(catalog, "recent", ""))).toEqual(["Dracula", "__manor__"]);
    expect(names(visibleThemes(catalog, "custom", ""))).toEqual(["custom:Paper"]);
  });

  it("a search looks across every theme whatever the filter", () => {
    expect(names(visibleThemes(catalog, "dark", "light"))).toEqual(["GitHub Light"]);
    expect(names(visibleThemes(catalog, "recent", "PAPER"))).toEqual(["custom:Paper"]);
  });
});

describe("filterCounts", () => {
  it("counts each filter", () => {
    expect(filterCounts(catalog)).toEqual({ recent: 2, all: 5, dark: 3, light: 2, custom: 1 });
  });
});

describe("gridMove", () => {
  // 4 columns, 10 tiles: rows 0-3, 4-7, 8-9.
  it("steps by a row up and down, staying put at the edges", () => {
    expect(gridMove(1, "ArrowDown", 4, 10)).toBe(5);
    expect(gridMove(6, "ArrowDown", 4, 10)).toBe(6);
    expect(gridMove(5, "ArrowUp", 4, 10)).toBe(1);
    expect(gridMove(2, "ArrowUp", 4, 10)).toBe(2);
  });

  it("runs left and right across rows and stops at the ends", () => {
    expect(gridMove(3, "ArrowRight", 4, 10)).toBe(4);
    expect(gridMove(9, "ArrowRight", 4, 10)).toBe(9);
    expect(gridMove(0, "ArrowLeft", 4, 10)).toBe(0);
  });

  it("starts on the first tile, and has nowhere to go in an empty wall", () => {
    expect(gridMove(-1, "ArrowDown", 4, 10)).toBe(0);
    expect(gridMove(-1, "ArrowDown", 4, 0)).toBe(-1);
  });
});

describe("copyName", () => {
  it("adds copy, then a number, ignoring case", () => {
    expect(copyName("Manor", ["Manor"])).toBe("Manor copy");
    expect(copyName("Manor", ["Manor", "manor COPY"])).toBe("Manor copy 2");
  });
});
