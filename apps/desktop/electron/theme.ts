import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { customThemesDir } from "./paths";

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
  /** The app's accent. Optional: without one the accent is `blue`. */
  accent?: string;
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

/**
 * Manor's own theme, in the marketing site's colours: soot black, bone white,
 * bile yellow for the accent, blood and wound pink for red and magenta.
 */
const MANOR_THEME: Theme = {
  background: "#11110a",
  foreground: "#fffdf2",
  cursor: "#ffe800",
  cursorAccent: "#11110a",
  selectionBackground: "#ffe800",
  selectionForeground: "#11110a",
  black: "#2a2a1c",
  red: "#f0213a",
  green: "#a8c23a",
  yellow: "#ffe800",
  blue: "#6b7bff",
  magenta: "#ff40b4",
  cyan: "#8fd3c8",
  white: "#d6d4cc",
  brightBlack: "#5c5a45",
  brightRed: "#ff5c6c",
  brightGreen: "#c6e05a",
  brightYellow: "#fff36b",
  brightBlue: "#949fff",
  brightMagenta: "#ff7ccb",
  brightCyan: "#b5ebe2",
  brightWhite: "#fffdf2",
  accent: "#ffe800",
};

/** Selection names that aren't a Ghostty theme file. */
export const GHOSTTY_CONFIG_THEME = "__ghostty__";
export const DEFAULT_THEME_NAME = "__default__";
export const MANOR_THEME_NAME = "__manor__";
/** A custom theme's selection name is this prefix and its file name. */
export const CUSTOM_PREFIX = "custom:";
const MAX_RECENT = 5;
const MAX_NAME_LENGTH = 64;

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
    const raw = trimmed.slice(eqIdx + 1).trim();
    const value = COLOR_KEYS.has(key) ? normalizeColor(raw) : raw;

    if (key === "palette") {
      const palEq = value.indexOf("=");
      if (palEq >= 0) {
        const idx = parseInt(value.slice(0, palEq).trim(), 10);
        if (!isNaN(idx)) {
          palette.set(idx, normalizeColor(value.slice(palEq + 1).trim()));
        }
      }
    } else {
      config.set(key, value);
    }
  }

  return { config, palette };
}

/**
 * Ghostty accepts a colour without its `#`; the renderer's colour maths needs
 * one. Anything that isn't a bare 6-digit hex is left as written.
 */
const COLOR_KEYS = new Set([
  "background",
  "foreground",
  "cursor-color",
  "cursor-text",
  "selection-background",
  "selection-foreground",
  "accent",
]);

function normalizeColor(value: string): string {
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : value;
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
  // Manor's own key; Ghostty ignores it.
  if (config.has("accent")) theme.accent = config.get("accent")!;

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

const PALETTE_KEYS: (keyof Theme)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** A theme as a Ghostty theme file, plus Manor's `accent` line. */
export function serializeTheme(theme: Theme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursor}`,
    `cursor-text = ${theme.cursorAccent}`,
    `selection-background = ${theme.selectionBackground}`,
    `selection-foreground = ${theme.selectionForeground}`,
    ...PALETTE_KEYS.map((key, i) => `palette = ${i}=${theme[key]}`),
  ];
  if (theme.accent) lines.push(`accent = ${theme.accent}`);
  return lines.join("\n") + "\n";
}

const THEME_KEYS: (keyof Theme)[] = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  ...PALETTE_KEYS,
];

/**
 * Check a theme from outside main and return it with every colour as
 * `#rrggbb`. It is written to disk and fed to the renderer's colour maths, so
 * nothing but colours gets through.
 */
export function assertTheme(value: unknown): Theme {
  if (typeof value !== "object" || value === null) {
    throw new Error("theme must be an object");
  }
  const input = value as Record<string, unknown>;
  const out = {} as Theme;
  for (const key of THEME_KEYS) {
    out[key] = assertColor(input[key], key);
  }
  if (input.accent !== undefined && input.accent !== null) {
    out.accent = assertColor(input.accent, "accent");
  }
  return out;
}

function assertColor(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a colour`);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  throw new Error(`${name} must be #rgb or #rrggbb, got ${JSON.stringify(value)}`);
}

/**
 * Check a custom theme's name. It becomes a file name in the themes folder,
 * so no separators, no leading dot and nothing invisible.
 */
export function assertThemeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("name must be a string");
  const name = value.trim();
  if (!name) throw new Error("Give the theme a name");
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Theme names are at most ${MAX_NAME_LENGTH} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f\x7f]/.test(name) || name.startsWith(".")) {
    throw new Error("Theme names can't contain slashes or start with a dot");
  }
  return name;
}

/** Whether a background is dark: the renderer's `themeColorScheme`, here. */
export function themeScheme(background: string): "dark" | "light" {
  const hex = normalizeColor(background);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lightness = ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
  return lightness < 50 ? "dark" : "light";
}

const SETTINGS_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Manor",
  "settings.json",
);

interface ThemeSettings {
  themeName?: string;
  /** Selection names, newest first, at most five. */
  recentThemes?: string[];
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
  | "accent"
>;

function colorsOf(theme: Theme): ThemeColors {
  const colors: ThemeColors = {
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    background: theme.background,
    foreground: theme.foreground,
  };
  if (theme.accent) colors.accent = theme.accent;
  return colors;
}

/** Where a theme in the list comes from. */
export type ThemeSource = "ghostty-config" | "builtin" | "custom" | "ghostty";

/** One theme as the picker shows it. */
export interface ThemeListEntry {
  /** The selection name: what `setSelected` and a project's `themeName` take. */
  name: string;
  displayName: string;
  source: ThemeSource;
  badge?: string;
  colors: ThemeColors;
  scheme: "dark" | "light";
}

/** Every theme there is, in picker order, and the recent picks among them. */
export interface ThemeCatalog {
  themes: ThemeListEntry[];
  /** Selection names, newest first; only ones still in `themes`. */
  recent: string[];
}

export class ThemeManager {
  private themeColorsCache: Record<string, ThemeColors> | null = null;
  private readonly settingsPath: string;
  private readonly customDir: string;

  constructor(opts: { settingsPath?: string; customThemesDir?: string } = {}) {
    this.settingsPath = opts.settingsPath ?? SETTINGS_PATH;
    this.customDir = opts.customThemesDir ?? customThemesDir();
  }

  private loadSettings(): ThemeSettings {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private saveSettings(settings: ThemeSettings): void {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

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
    if (name === DEFAULT_THEME_NAME) {
      return DEFAULT_THEME;
    }
    if (name === MANOR_THEME_NAME) {
      return MANOR_THEME;
    }
    if (name.startsWith(CUSTOM_PREFIX)) {
      return this.loadCustomTheme(name.slice(CUSTOM_PREFIX.length)) ?? DEFAULT_THEME;
    }
    return this.loadGhosttyTheme(name) ?? DEFAULT_THEME;
  }

  /** Get the active theme based on saved settings */
  getTheme(): Theme {
    const settings = this.loadSettings();
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
          result[name] = colorsOf(theme);
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
    const settings = this.loadSettings();
    return settings.themeName ?? GHOSTTY_CONFIG_THEME;
  }

  /** Save the selected theme name, and count it as a recent pick. */
  setSelectedThemeName(name: string): void {
    const settings = this.loadSettings();
    settings.themeName = name;
    settings.recentThemes = withRecent(settings.recentThemes, name);
    this.saveSettings(settings);
  }

  /** Count a pick that isn't the global theme (a project's) as recent. */
  addRecent(name: string): void {
    const settings = this.loadSettings();
    settings.recentThemes = withRecent(settings.recentThemes, name);
    this.saveSettings(settings);
  }

  /** Recent picks, newest first, as saved (some may since be gone). */
  getRecent(): string[] {
    const recent = this.loadSettings().recentThemes;
    return Array.isArray(recent)
      ? recent.filter((n): n is string => typeof n === "string")
      : [];
  }

  // ── Custom themes: one Ghostty-format file each in ~/.manor/themes ──

  /** A custom theme by its file name, or null when it can't be read. */
  loadCustomTheme(name: string): Theme | null {
    try {
      assertThemeName(name);
      const content = fs.readFileSync(path.join(this.customDir, name), "utf-8");
      const { config, palette } = parseGhosttyFile(content);
      return buildTheme(config, palette);
    } catch {
      return null;
    }
  }

  /** Custom themes' file names, sorted. Hidden and unreadable names skipped. */
  listCustomThemes(): string[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.customDir);
    } catch {
      return [];
    }
    return files
      .filter((f) => {
        try {
          // Not a name it could be saved or deleted under: leave it be.
          if (assertThemeName(f) !== f) return false;
          return fs.statSync(path.join(this.customDir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Write a custom theme and return its selection name. With `previousName`
   * it's an edit: a rename moves the file, and the selection and recents
   * follow it. Refuses a new name that another theme already has.
   */
  saveCustomTheme(name: string, theme: Theme, previousName?: string): string {
    const next = assertThemeName(name);
    const prev = previousName === undefined ? undefined : assertThemeName(previousName);
    const clean = assertTheme(theme);
    const target = path.join(this.customDir, next);
    const renaming = prev !== undefined && prev !== next;
    const exists = this.listCustomThemes().some(
      (n) => n.toLowerCase() === next.toLowerCase() && n !== prev,
    );
    if (exists) {
      throw new Error(`A theme called "${next}" already exists`);
    }
    fs.mkdirSync(this.customDir, { recursive: true });
    if (renaming) {
      // Move, then write: on a case-insensitive disk "Ink" → "ink" is one
      // file, so writing the new name and deleting the old would delete both.
      try {
        fs.renameSync(path.join(this.customDir, prev), target);
      } catch {
        // The old file is already gone: the write below makes the new one.
      }
    }
    fs.writeFileSync(target, serializeTheme(clean));
    if (renaming) {
      const from = CUSTOM_PREFIX + prev;
      const to = CUSTOM_PREFIX + next;
      const settings = this.loadSettings();
      if (settings.themeName === from) settings.themeName = to;
      settings.recentThemes = [
        ...new Set(settings.recentThemes?.map((n) => (n === from ? to : n))),
      ];
      this.saveSettings(settings);
    }
    return CUSTOM_PREFIX + next;
  }

  /**
   * Delete a custom theme. If it was selected, the selection goes back to
   * the default; it leaves the recents either way.
   */
  deleteCustomTheme(name: string): void {
    const clean = assertThemeName(name);
    fs.rmSync(path.join(this.customDir, clean), { force: true });
    const gone = CUSTOM_PREFIX + clean;
    const settings = this.loadSettings();
    if (settings.themeName === gone) delete settings.themeName;
    settings.recentThemes = settings.recentThemes?.filter((n) => n !== gone);
    this.saveSettings(settings);
  }

  /** Every theme in picker order, with the recent picks that still exist. */
  async catalog(): Promise<ThemeCatalog> {
    const entry = (
      name: string,
      displayName: string,
      source: ThemeSource,
      theme: Theme | ThemeColors,
      badge?: string,
    ): ThemeListEntry => {
      const colors = "cursor" in theme ? colorsOf(theme) : theme;
      return {
        name,
        displayName,
        source,
        ...(badge ? { badge } : {}),
        colors,
        scheme: themeScheme(colors.background),
      };
    };
    const themes: ThemeListEntry[] = [];
    if (this.hasGhosttyConfig()) {
      themes.push(
        entry(GHOSTTY_CONFIG_THEME, "Match Ghostty", "ghostty-config", this.loadGhosttyConfigTheme(), "Ghostty"),
      );
    }
    themes.push(entry(DEFAULT_THEME_NAME, "Catppuccin Mocha", "builtin", DEFAULT_THEME, "Default"));
    themes.push(entry(MANOR_THEME_NAME, "Manor", "builtin", MANOR_THEME, "Built-in"));
    for (const name of this.listCustomThemes()) {
      const theme = this.loadCustomTheme(name);
      if (theme) themes.push(entry(CUSTOM_PREFIX + name, name, "custom", theme));
    }
    const ghostty = await this.loadAllThemeColors();
    for (const name of Object.keys(ghostty).sort((a, b) => a.localeCompare(b))) {
      themes.push(entry(name, name, "ghostty", ghostty[name]));
    }
    const known = new Set(themes.map((t) => t.name));
    return { themes, recent: this.getRecent().filter((n) => known.has(n)) };
  }
}

/** `recent` with `name` moved to the front, at most five. */
function withRecent(recent: string[] | undefined, name: string): string[] {
  const prior = Array.isArray(recent) ? recent : [];
  return [name, ...prior.filter((n) => n !== name)].slice(0, MAX_RECENT);
}
