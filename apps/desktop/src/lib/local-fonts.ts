/**
 * The monospace font families installed on this machine, for the font
 * pickers in Settings.
 *
 * Read with the Local Font Access API (`queryLocalFonts`), which Manor's own
 * window is granted and browser panes are not (`electron/permission-policy`).
 * It lists every face of every family and says nothing about width, so the
 * families are collapsed and each is measured: a family whose narrowest and
 * widest letters take the same room is monospace.
 */

import { loadOnce } from "./load-once";

interface LocalFontData {
  family: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

/** Letters a proportional font draws at very different widths. */
const NARROW = "iiiiiillll";
const WIDE = "WWWWWWMMMM";

/** Whether `family` draws `NARROW` and `WIDE` at the same width. */
export function isMonospace(
  measure: (text: string, family: string) => number,
  family: string,
): boolean {
  const narrow = measure(NARROW, family);
  const wide = measure(WIDE, family);
  return narrow > 0 && Math.abs(narrow - wide) < 0.5;
}

/** The distinct families in `fonts`, sorted, keeping the ones `keep` accepts. */
export function monospaceFamilies(
  fonts: readonly LocalFontData[],
  keep: (family: string) => boolean,
): string[] {
  const families = [...new Set(fonts.map((f) => f.family))].filter(
    (family) => family && !family.startsWith("."),
  );
  return families.filter(keep).sort((a, b) => a.localeCompare(b));
}

async function loadMonospaceFonts(): Promise<string[]> {
  if (typeof window === "undefined" || !window.queryLocalFonts) return [];
  const fonts = await window.queryLocalFonts();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [];
  const measure = (text: string, family: string) => {
    ctx.font = `16px "${family.replace(/["\\]/g, "")}"`;
    return ctx.measureText(text).width;
  };
  return monospaceFamilies(fonts, (family) => isMonospace(measure, family));
}

/** Installed monospace families, read once; empty where the API is missing. */
export const listMonospaceFonts = loadOnce(loadMonospaceFonts);
