import { assertString } from "../ipc-validate";
import { publishRendererBroadcast } from "../renderer-broadcast";
import type { IpcDeps } from "./types";
import type { ThemeManager } from "../theme";

/**
 * Theme, whole (ADR-180 ticket 7). Every one of these was already an
 * `ipcMain.handle` wrapper around a plain function; the wrappers are gone
 * now, and the handler table (`electron/bridge/handlers.ts`) is the only
 * caller left. `setSelected` is not `LOCAL_ONLY` — a paired `full` device
 * setting the theme is ADR-179 D6's broadcast working as designed, and the
 * browser already re-renders on it.
 */
export function themeGet(deps: IpcDeps): unknown {
  return deps.themeManager.getTheme();
}

export function themeGetSelectedName(deps: IpcDeps): string {
  return deps.themeManager.getSelectedThemeName();
}

export function themeHasGhosttyConfig(deps: IpcDeps): boolean {
  return deps.themeManager.hasGhosttyConfig();
}

export function themePreview(deps: IpcDeps, name: string): unknown {
  assertString(name, "name");
  return deps.themeManager.getThemeByName(name);
}

export function themeAllColors(deps: IpcDeps): Promise<unknown> {
  return deps.themeManager.loadAllThemeColors();
}

/**
 * Select a theme and tell every viewer.
 *
 * A theme change is every viewer's, not just the caller's: without the
 * fan-out a second desktop window and every browser on the bridge kept the
 * old theme until they next remounted (ADR-179 ticket 7). Lifted out of the
 * IPC handler so the `POST /theme` route (CLI, MCP) reaches the same viewers
 * the IPC path does — the route used to change the theme silently, and the
 * handler table reaches it the same way (ADR-180 ticket 7).
 *
 * The caller learns the new theme from the return value; `publishRendererBroadcast`
 * covers everybody else now — the bridge's one sink reaches every other
 * window and every browser alike, so there is no second `webContents.send`
 * loop beside it any more.
 */
export function themeSetSelected(
  deps: Pick<IpcDeps, "themeManager">,
  name: string,
): ReturnType<ThemeManager["getTheme"]> {
  assertString(name, "name");
  deps.themeManager.setSelectedThemeName(name);
  const theme = deps.themeManager.getTheme();
  publishRendererBroadcast("theme", "changed", { name, theme });
  return theme;
}
