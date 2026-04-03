import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";

// Mock node:fs before importing the module under test
vi.mock("node:fs", () => {
  const mockReadFileSync = vi.fn();
  const mockExistsSync = vi.fn();
  const mockWriteFileSync = vi.fn();
  const mockMkdirSync = vi.fn();
  const mockReaddir = vi.fn();
  const mockReadFile = vi.fn();

  return {
    default: {
      readFileSync: mockReadFileSync,
      existsSync: mockExistsSync,
      writeFileSync: mockWriteFileSync,
      mkdirSync: mockMkdirSync,
      promises: {
        readdir: mockReaddir,
        readFile: mockReadFile,
      },
    },
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    promises: {
      readdir: mockReaddir,
      readFile: mockReadFile,
    },
  };
});

import fs from "node:fs";
import { ThemeManager } from "./theme";

// Paths that theme.ts checks
const HOME = os.homedir();
const MAC_GHOSTTY_CONFIG = path.join(
  HOME,
  "Library",
  "Application Support",
  "com.mitchellh.ghostty",
  "config",
);
const XDG_GHOSTTY_CONFIG = path.join(HOME, ".config", "ghostty", "config");
const APP_THEMES_DIR =
  "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";
const XDG_THEMES_DIR = path.join(
  HOME,
  "Library",
  "Application Support",
  "ghostty",
  "themes",
);
const SETTINGS_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "Manor",
  "settings.json",
);

const DEFAULT_THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b70",
  selectionForeground: "#cdd6f4",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#a6adc8",
  brightBlack: "#585b70",
  brightRed: "#f37799",
  brightGreen: "#89d88b",
  brightYellow: "#ebd391",
  brightBlue: "#74a8fc",
  brightMagenta: "#f2aede",
  brightCyan: "#6bd7ca",
  brightWhite: "#bac2de",
};

// Helpers
function mockExistsSync(paths: Record<string, boolean>) {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    return paths[p as string] ?? false;
  });
}

function noGhosttyConfig() {
  mockExistsSync({
    [MAC_GHOSTTY_CONFIG]: false,
    [XDG_GHOSTTY_CONFIG]: false,
    [APP_THEMES_DIR]: false,
    [XDG_THEMES_DIR]: false,
  });
}

function withMacGhosttyConfig(content: string, themesDir?: string) {
  const exists: Record<string, boolean> = {
    [MAC_GHOSTTY_CONFIG]: true,
    [XDG_GHOSTTY_CONFIG]: false,
  };
  if (themesDir) {
    exists[APP_THEMES_DIR] = themesDir === APP_THEMES_DIR;
    exists[XDG_THEMES_DIR] = themesDir === XDG_THEMES_DIR;
  } else {
    exists[APP_THEMES_DIR] = false;
    exists[XDG_THEMES_DIR] = false;
  }
  mockExistsSync(exists);
  vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
    if (p === MAC_GHOSTTY_CONFIG) return content;
    throw new Error(`ENOENT: ${p}`);
  });
}

function withAppThemesDir() {
  return APP_THEMES_DIR;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing exists
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
  vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("ENOENT"));
});

// ─── Ghostty config parsing ────────────────────────────────────────────────

describe("Ghostty config parsing (via loadGhosttyConfigTheme)", () => {
  it("parses key = value lines and ignores comments and blank lines", () => {
    const configContent = `
# This is a comment
background = #282c34

; another comment style (not standard but should be ignored if no =)
foreground = #abb2bf

`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.background).toBe("#282c34");
    expect(theme.foreground).toBe("#abb2bf");
    // cursorAccent follows background when no cursor-text set
    expect(theme.cursorAccent).toBe("#282c34");
    // selectionForeground follows foreground when no selection-foreground set
    expect(theme.selectionForeground).toBe("#abb2bf");
  });

  it("parses palette = N=color entries and maps to correct ANSI color slots", () => {
    const configContent = `
palette = 0=#000000
palette = 1=#ff0000
palette = 2=#00ff00
palette = 7=#ffffff
palette = 8=#808080
palette = 15=#f0f0f0
`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.black).toBe("#000000");
    expect(theme.red).toBe("#ff0000");
    expect(theme.green).toBe("#00ff00");
    expect(theme.white).toBe("#ffffff");
    expect(theme.brightBlack).toBe("#808080");
    expect(theme.brightWhite).toBe("#f0f0f0");
  });

  it("returns DEFAULT_THEME when Ghostty config file does not exist", () => {
    noGhosttyConfig();

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme).toEqual(DEFAULT_THEME);
  });

  it("returns DEFAULT_THEME when config file read throws", () => {
    mockExistsSync({ [MAC_GHOSTTY_CONFIG]: true });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("permission denied");
    });

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme).toEqual(DEFAULT_THEME);
  });
});

// ─── Theme building ────────────────────────────────────────────────────────

describe("Theme building", () => {
  it("maps palette indices 0-15 to correct theme keys", () => {
    const palette = [
      "#000000", // 0 = black
      "#ff0000", // 1 = red
      "#00ff00", // 2 = green
      "#ffff00", // 3 = yellow
      "#0000ff", // 4 = blue
      "#ff00ff", // 5 = magenta
      "#00ffff", // 6 = cyan
      "#ffffff", // 7 = white
      "#111111", // 8 = brightBlack
      "#ff1111", // 9 = brightRed
      "#11ff11", // 10 = brightGreen
      "#ffff11", // 11 = brightYellow
      "#1111ff", // 12 = brightBlue
      "#ff11ff", // 13 = brightMagenta
      "#11ffff", // 14 = brightCyan
      "#f0f0f0", // 15 = brightWhite
    ];
    const configContent = palette
      .map((color, i) => `palette = ${i}=${color}`)
      .join("\n");

    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.black).toBe("#000000");
    expect(theme.red).toBe("#ff0000");
    expect(theme.green).toBe("#00ff00");
    expect(theme.yellow).toBe("#ffff00");
    expect(theme.blue).toBe("#0000ff");
    expect(theme.magenta).toBe("#ff00ff");
    expect(theme.cyan).toBe("#00ffff");
    expect(theme.white).toBe("#ffffff");
    expect(theme.brightBlack).toBe("#111111");
    expect(theme.brightRed).toBe("#ff1111");
    expect(theme.brightGreen).toBe("#11ff11");
    expect(theme.brightYellow).toBe("#ffff11");
    expect(theme.brightBlue).toBe("#1111ff");
    expect(theme.brightMagenta).toBe("#ff11ff");
    expect(theme.brightCyan).toBe("#11ffff");
    expect(theme.brightWhite).toBe("#f0f0f0");
  });

  it("applies background and foreground overrides correctly", () => {
    const configContent = `
background = #aabbcc
foreground = #ddeeff
`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.background).toBe("#aabbcc");
    expect(theme.cursorAccent).toBe("#aabbcc");
    expect(theme.foreground).toBe("#ddeeff");
    expect(theme.selectionForeground).toBe("#ddeeff");
  });

  it("applies cursor-color override correctly", () => {
    const configContent = `cursor-color = #abcdef`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.cursor).toBe("#abcdef");
  });

  it("applies cursor-text override and takes precedence over background", () => {
    const configContent = `
background = #aabbcc
cursor-text = #112233
`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    // cursor-text overrides cursorAccent even after background sets it
    expect(theme.cursorAccent).toBe("#112233");
  });

  it("applies selection-background override correctly", () => {
    const configContent = `selection-background = #334455`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.selectionBackground).toBe("#334455");
  });

  it("applies selection-foreground override correctly", () => {
    const configContent = `selection-foreground = #667788`;
    withMacGhosttyConfig(configContent);

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    expect(theme.selectionForeground).toBe("#667788");
  });

  it("falls back to DEFAULT_THEME for missing values", () => {
    withMacGhosttyConfig("background = #000000");

    const manager = new ThemeManager();
    const theme = manager.loadGhosttyConfigTheme();

    // background overridden, but red falls through to default
    expect(theme.background).toBe("#000000");
    expect(theme.red).toBe(DEFAULT_THEME.red);
    expect(theme.cursor).toBe(DEFAULT_THEME.cursor);
  });
});

// ─── ThemeManager ─────────────────────────────────────────────────────────

describe("ThemeManager", () => {
  describe("getThemeByName", () => {
    it('returns the default theme for "__default__"', () => {
      const manager = new ThemeManager();
      const theme = manager.getThemeByName("__default__");
      expect(theme).toEqual(DEFAULT_THEME);
    });

    it('delegates to loadGhosttyConfigTheme for "__ghostty__"', () => {
      noGhosttyConfig();
      const manager = new ThemeManager();
      const theme = manager.getThemeByName("__ghostty__");
      // No config → default
      expect(theme).toEqual(DEFAULT_THEME);
    });

    it('delegates to loadGhosttyConfigTheme for empty string', () => {
      noGhosttyConfig();
      const manager = new ThemeManager();
      const theme = manager.getThemeByName("");
      expect(theme).toEqual(DEFAULT_THEME);
    });

    it("loads a named theme file via loadGhosttyTheme", () => {
      const themesDir = withAppThemesDir();
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: false,
        [XDG_GHOSTTY_CONFIG]: false,
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });
      const themeContent = `
background = #123456
foreground = #abcdef
`;
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === path.join(themesDir, "Dracula")) return themeContent;
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const theme = manager.getThemeByName("Dracula");

      expect(theme.background).toBe("#123456");
      expect(theme.foreground).toBe("#abcdef");
    });

    it("falls back to DEFAULT_THEME when named theme file not found", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: false,
        [XDG_GHOSTTY_CONFIG]: false,
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const manager = new ThemeManager();
      const theme = manager.getThemeByName("NonExistentTheme");

      expect(theme).toEqual(DEFAULT_THEME);
    });

    it("returns DEFAULT_THEME when no themes dir exists", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: false,
        [XDG_GHOSTTY_CONFIG]: false,
        [APP_THEMES_DIR]: false,
        [XDG_THEMES_DIR]: false,
      });

      const manager = new ThemeManager();
      const theme = manager.getThemeByName("SomeName");

      expect(theme).toEqual(DEFAULT_THEME);
    });
  });

  describe("getTheme", () => {
    it("reads settings.json and delegates to getThemeByName", () => {
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === SETTINGS_PATH)
          return JSON.stringify({ themeName: "__default__" });
        throw new Error(`ENOENT: ${p}`);
      });
      mockExistsSync({});

      const manager = new ThemeManager();
      const theme = manager.getTheme();

      expect(theme).toEqual(DEFAULT_THEME);
    });

    it('falls back to "__ghostty__" when no setting saved', () => {
      // settings.json throws (file missing)
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });
      noGhosttyConfig();

      const manager = new ThemeManager();
      const theme = manager.getTheme();

      // ghostty path → no config → default theme
      expect(theme).toEqual(DEFAULT_THEME);
    });
  });

  describe("getSelectedThemeName", () => {
    it('returns "__ghostty__" when no setting saved', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const manager = new ThemeManager();
      expect(manager.getSelectedThemeName()).toBe("__ghostty__");
    });

    it("returns saved theme name when present", () => {
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === SETTINGS_PATH) return JSON.stringify({ themeName: "Dracula" });
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      expect(manager.getSelectedThemeName()).toBe("Dracula");
    });
  });

  describe("setSelectedThemeName", () => {
    it("persists theme name to settings.json", () => {
      // Initial load of settings (file doesn't exist yet)
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      let writtenContent = "";
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenContent = data as string;
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);

      const manager = new ThemeManager();
      manager.setSelectedThemeName("Catppuccin");

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.dirname(SETTINGS_PATH),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        SETTINGS_PATH,
        expect.any(String),
      );
      const parsed = JSON.parse(writtenContent);
      expect(parsed.themeName).toBe("Catppuccin");
    });

    it("merges with existing settings when saving", () => {
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === SETTINGS_PATH)
          return JSON.stringify({ someOtherKey: "value" });
        throw new Error(`ENOENT: ${p}`);
      });

      let writtenContent = "";
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenContent = data as string;
      });
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);

      const manager = new ThemeManager();
      manager.setSelectedThemeName("Nord");

      const parsed = JSON.parse(writtenContent);
      expect(parsed.themeName).toBe("Nord");
      expect(parsed.someOtherKey).toBe("value");
    });
  });

  describe("hasGhosttyConfig", () => {
    it("returns true when macOS Ghostty config exists", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: true,
        [XDG_GHOSTTY_CONFIG]: false,
      });

      const manager = new ThemeManager();
      expect(manager.hasGhosttyConfig()).toBe(true);
    });

    it("returns true when XDG Ghostty config exists", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: false,
        [XDG_GHOSTTY_CONFIG]: true,
      });

      const manager = new ThemeManager();
      expect(manager.hasGhosttyConfig()).toBe(true);
    });

    it("returns false when no Ghostty config exists", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: false,
        [XDG_GHOSTTY_CONFIG]: false,
      });

      const manager = new ThemeManager();
      expect(manager.hasGhosttyConfig()).toBe(false);
    });
  });

  describe("loadGhosttyTheme", () => {
    it("returns null when themes directory does not exist", () => {
      mockExistsSync({
        [APP_THEMES_DIR]: false,
        [XDG_THEMES_DIR]: false,
      });

      const manager = new ThemeManager();
      const result = manager.loadGhosttyTheme("Dracula");

      expect(result).toBeNull();
    });

    it("returns null when theme file read fails", () => {
      mockExistsSync({
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const manager = new ThemeManager();
      const result = manager.loadGhosttyTheme("NonExistent");

      expect(result).toBeNull();
    });

    it("parses and returns theme from file content", () => {
      mockExistsSync({
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === path.join(APP_THEMES_DIR, "MyTheme")) {
          return `background = #ff0000\nforeground = #00ff00\npalette = 0=#aabbcc`;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const theme = manager.loadGhosttyTheme("MyTheme");

      expect(theme).not.toBeNull();
      expect(theme!.background).toBe("#ff0000");
      expect(theme!.foreground).toBe("#00ff00");
      expect(theme!.black).toBe("#aabbcc");
    });
  });

  describe("loadGhosttyConfigTheme with theme reference", () => {
    it("loads theme file referenced in config and merges config overrides", () => {
      const themesDir = APP_THEMES_DIR;
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: true,
        [XDG_GHOSTTY_CONFIG]: false,
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });

      const configContent = `
theme = Dracula
background = #override
`;
      const themeFileContent = `
background = #dracula-bg
foreground = #dracula-fg
`;
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === MAC_GHOSTTY_CONFIG) return configContent;
        if (p === path.join(themesDir, "Dracula")) return themeFileContent;
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const theme = manager.loadGhosttyConfigTheme();

      // Config override (#override) should take precedence over theme file (#dracula-bg)
      expect(theme.background).toBe("#override");
      // Foreground from theme file (not overridden in config)
      expect(theme.foreground).toBe("#dracula-fg");
    });

    it("falls back to direct config parse when theme file not found", () => {
      mockExistsSync({
        [MAC_GHOSTTY_CONFIG]: true,
        [XDG_GHOSTTY_CONFIG]: false,
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });

      const configContent = `
theme = MissingTheme
background = #direct
`;
      vi.mocked(fs.readFileSync).mockImplementation((p, _enc) => {
        if (p === MAC_GHOSTTY_CONFIG) return configContent;
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const theme = manager.loadGhosttyConfigTheme();

      expect(theme.background).toBe("#direct");
    });
  });

  describe("loadAllThemeColors", () => {
    it("returns empty object when no themes directory exists", async () => {
      mockExistsSync({
        [APP_THEMES_DIR]: false,
        [XDG_THEMES_DIR]: false,
      });

      const manager = new ThemeManager();
      const colors = await manager.loadAllThemeColors();

      expect(colors).toEqual({});
    });

    it("returns color palettes for all theme files", async () => {
      mockExistsSync({
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });

      vi.mocked(fs.promises.readdir).mockResolvedValue([
        "Dracula",
        "Nord",
      ] as any);
      vi.mocked(fs.promises.readFile).mockImplementation(async (p) => {
        if (String(p) === path.join(APP_THEMES_DIR, "Dracula")) {
          return `background = #282a36\nforeground = #f8f8f2\npalette = 1=#ff5555`;
        }
        if (String(p) === path.join(APP_THEMES_DIR, "Nord")) {
          return `background = #2e3440\nforeground = #d8dee9`;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const colors = await manager.loadAllThemeColors();

      expect(Object.keys(colors)).toContain("Dracula");
      expect(Object.keys(colors)).toContain("Nord");
      expect(colors["Dracula"].background).toBe("#282a36");
      expect(colors["Dracula"].foreground).toBe("#f8f8f2");
      expect(colors["Dracula"].red).toBe("#ff5555");
      expect(colors["Nord"].background).toBe("#2e3440");
    });

    it("skips dot-files", async () => {
      mockExistsSync({
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });

      vi.mocked(fs.promises.readdir).mockResolvedValue([
        ".hidden",
        "Visible",
      ] as any);
      vi.mocked(fs.promises.readFile).mockImplementation(async (p) => {
        if (String(p) === path.join(APP_THEMES_DIR, "Visible")) {
          return `background = #aabbcc`;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      const manager = new ThemeManager();
      const colors = await manager.loadAllThemeColors();

      expect(Object.keys(colors)).not.toContain(".hidden");
      expect(Object.keys(colors)).toContain("Visible");
    });

    it("caches results after first call", async () => {
      mockExistsSync({
        [APP_THEMES_DIR]: true,
        [XDG_THEMES_DIR]: false,
      });

      vi.mocked(fs.promises.readdir).mockResolvedValue(["Theme1"] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "background = #111111" as any,
      );

      const manager = new ThemeManager();
      await manager.loadAllThemeColors();
      await manager.loadAllThemeColors();

      expect(fs.promises.readdir).toHaveBeenCalledTimes(1);
    });
  });
});
