import { applyCssVars, useThemeStore, type Theme } from "../store/theme-store";

/**
 * The last theme this browser showed, kept across loads. The theme is home's
 * answer (`theme-store.ts`), so a page loaded with home away — the laptop
 * asleep — would otherwise paint its boot and not-reachable screens in
 * `web.html`'s fallback colours rather than the user's theme.
 *
 * Wrapped like every other storage access here: a browser that refuses
 * `localStorage` simply starts in the fallback colours.
 */
const THEME_KEY = "manor.web.lastTheme";

function readCachedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Theme).background === "string" &&
      typeof (parsed as Theme).foreground === "string"
    ) {
      return parsed as Theme;
    }
  } catch {
    // Unreadable or refused: no theme to restore.
  }
  return null;
}

/** Paint the cached theme now, and keep the cache following the shown one. */
export function restoreAndFollowTheme(): void {
  const cached = readCachedTheme();
  if (cached) applyCssVars(cached);
  useThemeStore.subscribe((state, previous) => {
    if (!state.theme || state.theme === previous.theme) return;
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(state.theme));
    } catch {
      // Full or refused: the next load starts in the fallback colours.
    }
  });
}
