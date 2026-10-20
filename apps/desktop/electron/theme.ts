import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const DEFAULT_THEME: Theme = {
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

function ghosttyConfigPath(): string | null {
  // macOS: ~/Library/Application Support/com.mitchellh.ghostty/config
  const macPath = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.mitchellh.ghostty",
    "config",
  );
  if (fs.existsSync(macPath)) return macPath;

  // XDG: ~/.config/ghostty/config
  const xdgPath = path.join(os.homedir(), ".config", "ghostty", "config");
  if (fs.existsSync(xdgPath)) return xdgPath;

  return null;
}

function ghosttyThemesDir(): string | null {
  const appThemes =
    "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";
  if (fs.existsSync(appThemes)) return appThemes;

  const xdgThemes = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "ghostty",
    "themes",
  );
  if (fs.existsSync(xdgThemes)) return xdgThemes;

  return null;
}

function parseGhosttyFile(content: string): {
  config: Map<string, string>;
  palette: Map<number, string>;
} {
  const config = new Map<string, string>();
  const palette = new Map<number, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (key === "palette") {
      const palEq = value.indexOf("=");
      if (palEq >= 0) {
        const idx = parseInt(value.slice(0, palEq).trim(), 10);
        if (!isNaN(idx)) {
          palette.set(idx, value.slice(palEq + 1).trim());
        }
      }
    } else {
      config.set(key, value);
    }
  }

  return { config, palette };
}

function loadThemeFromConfig(config: Map<string, string>): Theme {
  const theme = { ...DEFAULT_THEME };

  const bg = config.get("background");
  if (bg) {
    theme.background = bg;
    theme.cursorAccent = bg;
  }
  const fg = config.get("foreground");
  if (fg) {
    theme.foreground = fg;
    theme.selectionForeground = fg;
  }
  if (config.has("cursor-color")) theme.cursor = config.get("cursor-color")!;
  if (config.has("cursor-text"))
    theme.cursorAccent = config.get("cursor-text")!;
  if (config.has("selection-background"))
    theme.selectionBackground = config.get("selection-background")!;
  if (config.has("selection-foreground"))
    theme.selectionForeground = config.get("selection-foreground")!;

  return theme;
}

function buildTheme(
  config: Map<string, string>,
  palette: Map<number, string>,
): Theme {
  const theme = loadThemeFromConfig(config);

  const paletteMap: [number, keyof Theme][] = [
    [0, "black"],
    [1, "red"],
    [2, "green"],
    [3, "yellow"],
    [4, "blue"],
    [5, "magenta"],
    [6, "cyan"],
    [7, "white"],
    [8, "brightBlack"],
    [9, "brightRed"],
    [10, "brightGreen"],
    [11, "brightYellow"],
    [12, "brightBlue"],
    [13, "brightMagenta"],
    [14, "brightCyan"],
    [15, "brightWhite"],
  ];

  for (const [idx, key] of paletteMap) {
    const color = palette.get(idx);
    if (color) {
      theme[key] = color;
    }
  }

  return theme;
}

const SETTINGS_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Manor",
  "settings.json",
);

function loadSettings(): { themeName?: string } {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: { themeName?: string }): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export type ThemeColors = Pick<
  Theme,
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "background"
  | "foreground"
>;

export class ThemeManager {
  private themeColorsCache: Record<string, ThemeColors> | null = null;

  /** Load a specific Ghostty theme file by name */
  loadGhosttyTheme(name: string): Theme | null {
    const themesDir = ghosttyThemesDir();
    if (!themesDir) return null;
    try {
      const content = fs.readFileSync(path.join(themesDir, name), "utf-8");
      const { config, palette } = parseGhosttyFile(content);
      return buildTheme(config, palette);
    } catch {
      return null;
    }
  }

  /** Load theme from Ghostty config (match Ghostty) */
  loadGhosttyConfigTheme(): Theme {
    const configPath = ghosttyConfigPath();
    if (!configPath) return DEFAULT_THEME;

    let content: string;
    try {
      content = fs.readFileSync(configPath, "utf-8");
    } catch {
      return DEFAULT_THEME;
    }

    const { config, palette: _palette } = parseGhosttyFile(content);

    const themeName = config.get("theme");
    if (themeName) {
      const themesDir = ghosttyThemesDir();
      if (themesDir) {
        try {
          const themeContent = fs.readFileSync(
            path.join(themesDir, themeName),
            "utf-8",
          );
          const { config: themeConfig, palette: themePalette } =
            parseGhosttyFile(themeContent);
          for (const [key, value] of config) {
            if (key !== "theme") themeConfig.set(key, value);
          }
          return buildTheme(themeConfig, themePalette);
        } catch {
          // Fall through
        }
      }
    }

    const { config: directConfig, palette } = parseGhosttyFile(content);
    return buildTheme(directConfig, palette);
  }

  /** Resolve a theme by name, handling special values __ghostty__ and __default__ */
  getThemeByName(name: string): Theme {
    if (!name || name === "__ghostty__") {
      return this.loadGhosttyConfigTheme();
    }
    if (name === "__default__") {
      return DEFAULT_THEME;
    }
    return this.loadGhosttyTheme(name) ?? DEFAULT_THEME;
  }

  /** Get the active theme based on saved settings */
  getTheme(): Theme {
    const settings = loadSettings();
    const themeName = settings.themeName;
    return this.getThemeByName(themeName ?? "__ghostty__");
  }

  /** Load color palettes for all themes (cached after first call) */
  async loadAllThemeColors(): Promise<Record<string, ThemeColors>> {
    if (this.themeColorsCache) return this.themeColorsCache;

    const themesDir = ghosttyThemesDir();
    if (!themesDir) return {};

    const result: Record<string, ThemeColors> = {};
    try {
      const files = (await fs.promises.readdir(themesDir)).filter(
        (f) => !f.startsWith("."),
      );
      const reads = files.map(async (name) => {
        try {
          const content = await fs.promises.readFile(
            path.join(themesDir, name),
            "utf-8",
          );
          const { config, palette } = parseGhosttyFile(content);
          const theme = buildTheme(config, palette);
          result[name] = {
            red: theme.red,
            green: theme.green,
            yellow: theme.yellow,
            blue: theme.blue,
            magenta: theme.magenta,
            cyan: theme.cyan,
            background: theme.background,
            foreground: theme.foreground,
          };
        } catch {
          // skip unreadable themes
        }
      });
      await Promise.all(reads);
    } catch {
      // ignore
    }
    this.themeColorsCache = result;
    return result;
  }

  /** Check if Ghostty config exists on this system */
  hasGhosttyConfig(): boolean {
    return ghosttyConfigPath() !== null;
  }

  /** Get the saved theme name from settings */
  getSelectedThemeName(): string {
    const settings = loadSettings();
    return settings.themeName ?? "__ghostty__";
  }

  /** Save the selected theme name */
  setSelectedThemeName(name: string): void {
    const settings = loadSettings();
    settings.themeName = name;
    saveSettings(settings);
  }
}
