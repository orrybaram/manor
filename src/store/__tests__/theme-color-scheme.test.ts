import { describe, expect, it } from "vitest";
import { themeColorScheme } from "../theme-store";
import type { Theme } from "../theme-store";

function theme(background: string): Theme {
  return {
    background,
    foreground: "#cdd6f4",
    cursor: "#cdd6f4",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b70",
    selectionForeground: "#cdd6f4",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#cba6f7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#cba6f7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  };
}

// Themes are terminal colour schemes, so the app cannot assume dark: the
// scrollbars have to follow whichever the user picked.
describe("themeColorScheme", () => {
  it("reads dark from a dark background", () => {
    expect(themeColorScheme(theme("#1e1e2e"))).toBe("dark");
    expect(themeColorScheme(theme("#000000"))).toBe("dark");
  });

  it("reads light from a light background", () => {
    expect(themeColorScheme(theme("#eff1f5"))).toBe("light");
    expect(themeColorScheme(theme("#ffffff"))).toBe("light");
  });
});
