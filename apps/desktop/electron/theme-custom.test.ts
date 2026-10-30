import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ThemeManager,
  assertTheme,
  assertThemeName,
  serializeTheme,
  themeScheme,
  type Theme,
} from "./theme";

let dir: string;
let themesDir: string;
let manager: ThemeManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-themes-"));
  themesDir = path.join(dir, "themes");
  manager = new ThemeManager({
    settingsPath: path.join(dir, "settings.json"),
    customThemesDir: themesDir,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const manor = () => manager.getThemeByName("__manor__");
const settings = () =>
  JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));

describe("Manor theme", () => {
  it("is a dark theme with the site's bile yellow as its accent", () => {
    const theme = manor();
    expect(theme.accent).toBe("#ffe800");
    expect(theme.foreground).toBe("#fffdf2");
    expect(themeScheme(theme.background)).toBe("dark");
  });
});

describe("accent", () => {
  it("is read from a theme file's accent line, and absent without one", () => {
    fs.mkdirSync(themesDir);
    fs.writeFileSync(path.join(themesDir, "With"), "background = #101010\naccent = #ff8800\n");
    fs.writeFileSync(path.join(themesDir, "Without"), "background = #101010\n");
    expect(manager.getThemeByName("custom:With").accent).toBe("#ff8800");
    expect(manager.getThemeByName("custom:Without").accent).toBeUndefined();
  });

  it("round-trips through serializeTheme", () => {
    const theme = { ...manor(), accent: "#123456" };
    fs.mkdirSync(themesDir);
    fs.writeFileSync(path.join(themesDir, "Copy"), serializeTheme(theme));
    expect(manager.getThemeByName("custom:Copy")).toEqual(theme);
  });
});

describe("recent themes", () => {
  it("keeps the last five picks, newest first, without repeats", () => {
    for (const n of ["a", "b", "c", "a", "d", "e", "f"]) {
      manager.addRecent(n);
    }
    expect(manager.getRecent()).toEqual(["f", "e", "d", "a", "c"]);
  });

  it("doesn't count a selection by itself (Settings counts on close)", () => {
    manager.setSelectedThemeName("a");
    manager.addRecent("__manor__");
    expect(manager.getSelectedThemeName()).toBe("a");
    expect(manager.getRecent()).toEqual(["__manor__"]);
  });

  it("survives a new manager (a restart)", () => {
    manager.addRecent("__manor__");
    const again = new ThemeManager({
      settingsPath: path.join(dir, "settings.json"),
      customThemesDir: themesDir,
    });
    expect(again.getRecent()).toEqual(["__manor__"]);
  });

  it("lists only recents that still exist in the catalog", async () => {
    manager.addRecent("Gone Theme");
    manager.addRecent("__manor__");
    const { recent } = await manager.catalog();
    expect(recent).toEqual(["__manor__"]);
  });
});

describe("custom themes", () => {
  it("saves a file in the themes folder and returns its selection name", () => {
    const name = manager.saveCustomTheme("Ink", manor());
    expect(name).toBe("custom:Ink");
    const file = fs.readFileSync(path.join(themesDir, "Ink"), "utf-8");
    expect(file).toContain("background = #11110a");
    expect(file).toContain("accent = #ffe800");
    expect(manager.getThemeByName("custom:Ink")).toEqual(manor());
  });

  it("refuses a second theme with the same name", () => {
    manager.saveCustomTheme("Ink", manor());
    expect(() => manager.saveCustomTheme("ink", manor())).toThrow(/already exists/);
  });

  it("edits in place, and a rename carries the selection and recents along", () => {
    manager.saveCustomTheme("Ink", manor());
    manager.setSelectedThemeName("custom:Ink");
    manager.addRecent("custom:Ink");
    manager.saveCustomTheme("Ink", { ...manor(), red: "#ff0000" }, "Ink");
    expect(manager.getThemeByName("custom:Ink").red).toBe("#ff0000");

    manager.saveCustomTheme("Squid", manor(), "Ink");
    expect(fs.existsSync(path.join(themesDir, "Ink"))).toBe(false);
    expect(manager.getSelectedThemeName()).toBe("custom:Squid");
    expect(manager.getRecent()).toEqual(["custom:Squid"]);
  });

  it("a case-only rename keeps the theme (one file on a case-insensitive disk)", () => {
    manager.saveCustomTheme("Ink", manor());
    manager.saveCustomTheme("ink", manor(), "Ink");
    expect(manager.listCustomThemes()).toEqual(["ink"]);
    expect(manager.getThemeByName("custom:ink")).toEqual(manor());
  });

  it("deleting the selected theme falls back to the default and drops it from recents", () => {
    manager.saveCustomTheme("Ink", manor());
    manager.addRecent("__manor__");
    manager.setSelectedThemeName("custom:Ink");
    manager.addRecent("custom:Ink");
    manager.deleteCustomTheme("Ink");
    expect(fs.existsSync(path.join(themesDir, "Ink"))).toBe(false);
    expect(manager.getSelectedThemeName()).toBe("__ghostty__");
    expect(manager.getRecent()).toEqual(["__manor__"]);
  });

  it("lists hand-dropped files and skips hidden ones", async () => {
    fs.mkdirSync(themesDir);
    fs.writeFileSync(path.join(themesDir, "Dropped"), "background = fafafa\nforeground = 111111\n");
    fs.writeFileSync(path.join(themesDir, ".DS_Store"), "");
    const { themes } = await manager.catalog();
    const custom = themes.filter((t) => t.source === "custom");
    expect(custom.map((t) => t.name)).toEqual(["custom:Dropped"]);
    // A colour written without its # still reads as a light background.
    expect(custom[0].scheme).toBe("light");
    expect(custom[0].colors.background).toBe("#fafafa");
  });
});

describe("catalog", () => {
  it("lists the built-ins first, Manor among them", async () => {
    const { themes } = await manager.catalog();
    const builtins = themes.filter((t) => t.source === "builtin");
    expect(builtins.map((t) => [t.name, t.displayName, t.badge])).toEqual([
      ["__default__", "Catppuccin Mocha", "Default"],
      ["__manor__", "Manor", "Built-in"],
    ]);
    expect(builtins.find((t) => t.name === "__manor__")?.colors.accent).toBe("#ffe800");
  });
});

describe("validation", () => {
  it.each(["", "   ", "../x", "a/b", "a\\b", ".hidden", "x".repeat(65), "a\nb"])(
    "refuses the name %j",
    (name) => {
      expect(() => assertThemeName(name)).toThrow();
    },
  );

  it("accepts ordinary names, trimmed", () => {
    expect(assertThemeName("  Midnight Ink 2 ")).toBe("Midnight Ink 2");
  });

  it("expands #rgb, lowercases, and refuses anything that isn't a colour", () => {
    const theme = { ...manor(), red: "#F00" } as Theme;
    expect(assertTheme(theme).red).toBe("#ff0000");
    expect(() => assertTheme({ ...manor(), red: "red; }" })).toThrow();
    expect(() => assertTheme({ ...manor(), blue: undefined })).toThrow();
    expect(() => assertTheme(null)).toThrow();
  });

  it("keeps out keys that aren't colours", () => {
    const out = assertTheme({ ...manor(), extra: "#000000" }) as unknown as Record<string, unknown>;
    expect(out.extra).toBeUndefined();
  });
});
