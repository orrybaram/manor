import { create } from "zustand";

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

interface ThemeState {
  theme: Theme | null;
  selectedThemeName: string;
  loadTheme: () => Promise<void>;
  setTheme: (name: string) => Promise<void>;
}

function applyCssVars(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--fg", theme.foreground);
  root.style.setProperty("--dim", adjustBrightness(theme.background, 0.02));
  root.style.setProperty("--surface", adjustBrightness(theme.background, 0.08));
  root.style.setProperty("--hover", adjustBrightness(theme.background, 0.05));
  root.style.setProperty("--border", adjustBrightness(theme.background, 0.1));
  root.style.setProperty("--text-primary", withAlpha(theme.foreground, 0.7));
  root.style.setProperty("--text-selected", theme.foreground);
  root.style.setProperty("--text-dim", withAlpha(theme.foreground, 0.4));
  root.style.setProperty("--accent", theme.blue);

  // Palette colors
  root.style.setProperty("--red", theme.red);
  root.style.setProperty("--green", theme.green);
  root.style.setProperty("--yellow", theme.yellow);
  root.style.setProperty("--blue", theme.blue);
  root.style.setProperty("--magenta", theme.magenta);
  root.style.setProperty("--cyan", theme.cyan);

  // Alpha variants
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
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: null,
  selectedThemeName: "__ghostty__",

  loadTheme: async () => {
    const [theme, selectedThemeName] = await Promise.all([
      window.electronAPI.theme.get(),
      window.electronAPI.theme.getSelectedName(),
    ]);
    set({ theme, selectedThemeName });
    applyCssVars(theme);
  },

  setTheme: async (name: string) => {
    const theme = await window.electronAPI.theme.setSelected(name);
    set({ theme, selectedThemeName: name });
    applyCssVars(theme);
  },
}));

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
