/**
 * The app's theme tokens, scoped to one element instead of the document, so a
 * mount can wear its own theme without touching the homepage.
 *
 * Palettes are copied from apps/desktop/electron/theme.ts. `applyTheme` and its
 * helpers are ports of apps/desktop/src/store/theme-store.ts (`applyCssVars`,
 * `themeColorScheme`, `adjustBrightness`, `withAlpha`, `hexToHsl`, `hslToHex`);
 * `--term-*` carries apps/desktop/src/terminal/config.ts `themeToXterm`.
 */

export type Theme = {
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
};

/** Catppuccin Mocha: the app's `DEFAULT_THEME`. */
export const DEFAULT_THEME: Theme = {
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

/** Manor's own theme: the app's `MANOR_THEME`. */
export const MANOR_THEME: Theme = {
  background: "#181616",
  foreground: "#dbd3cc",
  cursor: "#12f9de",
  cursorAccent: "#11110a",
  selectionBackground: "#f7d21d",
  selectionForeground: "#11110a",
  black: "#2a2a1c",
  red: "#f0213a",
  green: "#57c039",
  yellow: "#f7d21d",
  blue: "#6b7bff",
  magenta: "#ff40b4",
  cyan: "#12f9de",
  white: "#d6d4cc",
  brightBlack: "#5c5a45",
  brightRed: "#ff5c6c",
  brightGreen: "#96e580",
  brightYellow: "#f2dd78",
  brightBlue: "#949fff",
  brightMagenta: "#ff7ccb",
  brightCyan: "#a3e6db",
  brightWhite: "#fffdf2",
  accent: "#10f9de",
};

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h /= 360;
  s /= 100;
  l /= 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) =>
    Math.round(Math.min(255, Math.max(0, x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function adjustBrightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, Math.min(100, l + delta * 100)));
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/** Which way native chrome should paint: read off the background's lightness. */
export function themeColorScheme(theme: Theme): "dark" | "light" {
  const [, , lightness] = hexToHsl(theme.background);
  return lightness < 50 ? "dark" : "light";
}

const TERMINAL_COLORS = [
  ["cursor", "cursor"],
  ["cursor-accent", "cursorAccent"],
  ["selection-bg", "selectionBackground"],
  ["selection-fg", "selectionForeground"],
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["magenta", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["bright-black", "brightBlack"],
  ["bright-red", "brightRed"],
  ["bright-green", "brightGreen"],
  ["bright-yellow", "brightYellow"],
  ["bright-blue", "brightBlue"],
  ["bright-magenta", "brightMagenta"],
  ["bright-cyan", "brightCyan"],
  ["bright-white", "brightWhite"],
] as const satisfies readonly (readonly [string, keyof Theme])[];

/** Every variable the app's `applyCssVars` sets, on `root` rather than the document. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.style.colorScheme = themeColorScheme(theme);
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--fg", theme.foreground);
  root.style.setProperty("--dim", adjustBrightness(theme.background, 0.02));
  root.style.setProperty("--surface", adjustBrightness(theme.background, 0.08));
  root.style.setProperty("--hover", adjustBrightness(theme.background, 0.05));
  root.style.setProperty("--border", adjustBrightness(theme.background, 0.1));
  root.style.setProperty("--control-border", withAlpha(theme.foreground, 0.25));
  root.style.setProperty("--text-primary", withAlpha(theme.foreground, 0.7));
  root.style.setProperty("--text-selected", theme.foreground);
  root.style.setProperty("--text-dim", withAlpha(theme.foreground, 0.4));
  root.style.setProperty("--accent", theme.accent ?? theme.blue);

  root.style.setProperty("--red", theme.red);
  root.style.setProperty("--green", theme.green);
  root.style.setProperty("--yellow", theme.yellow);
  root.style.setProperty("--blue", theme.blue);
  root.style.setProperty("--magenta", theme.magenta);
  root.style.setProperty("--cyan", theme.cyan);

  const alphaSteps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const colors = {
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    bg: theme.background,
    fg: theme.foreground,
  };
  for (const [name, hex] of Object.entries(colors)) {
    for (const a of alphaSteps) {
      const pct = Math.round(a * 100);
      root.style.setProperty(`--${name}-a${pct}`, withAlpha(hex, a));
    }
  }

  // The terminal's ANSI palette, which the app hands to xterm instead of CSS.
  for (const [name, key] of TERMINAL_COLORS) {
    root.style.setProperty(`--term-${name}`, theme[key] ?? "");
  }
}
