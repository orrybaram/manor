import { assertString } from "../../ipc-validate";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";
import type { Theme, ThemeColors } from "../../theme";

/**
 * Theme, whole (ADR-180 ticket 7), as the `theme` namespace of the handler
 * table. `setSelected` is not local-only — a paired `full` device setting the
 * theme is ADR-179 D6's broadcast working as designed, and the browser
 * already re-renders on it.
 */
export function themeGet(ctx: HandlerCtx): Theme {
  return ctx.deps.themeManager.getTheme();
}

export function themeGetSelectedName(ctx: HandlerCtx): string {
  return ctx.deps.themeManager.getSelectedThemeName();
}

export function themeHasGhosttyConfig(ctx: HandlerCtx): boolean {
  return ctx.deps.themeManager.hasGhosttyConfig();
}

export function themePreview(ctx: HandlerCtx, name: string): Theme {
  assertString(name, "name");
  return ctx.deps.themeManager.getThemeByName(name);
}

export function themeAllColors(
  ctx: HandlerCtx,
): Promise<Record<string, ThemeColors>> {
  return ctx.deps.themeManager.loadAllThemeColors();
}

/**
 * Select a theme and tell every viewer.
 *
 * A theme change is every viewer's, not just the caller's: without the
 * fan-out a second desktop window and every browser on the bridge kept the
 * old theme until they next remounted (ADR-179 ticket 7). The `POST /theme`
 * route (CLI, MCP) calls this too, so it reaches the same viewers; it needs
 * only the theme manager, and has no caller to name.
 *
 * The caller learns the new theme from the return value;
 * `publishRendererBroadcast` covers everybody else.
 */
export function themeSetSelected(
  ctx: { deps: Pick<HostDeps, "themeManager"> },
  name: string,
): Theme {
  assertString(name, "name");
  ctx.deps.themeManager.setSelectedThemeName(name);
  const theme = ctx.deps.themeManager.getTheme();
  publishRendererBroadcast("theme", "changed", { name, theme });
  return theme;
}

export const theme = {
  get: method(themeGet),
  getSelectedName: method(themeGetSelectedName),
  hasGhosttyConfig: method(themeHasGhosttyConfig),
  preview: method(themePreview),
  allColors: method(themeAllColors),
  setSelected: method(themeSetSelected),
};
