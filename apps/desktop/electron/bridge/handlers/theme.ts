import { assertString } from "../../ipc-validate";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { ServerDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";
import {
  CUSTOM_PREFIX,
  assertTheme,
  assertThemeName,
  type Theme,
  type ThemeCatalog,
  type ThemeColors,
} from "../../theme";

/**
 * Theme, whole, as the `theme` namespace of the handler
 * table. `setSelected` is not local-only — a paired `full` device setting the
 * theme is the theme broadcast working as designed, and the browser
 * already re-renders on it.
 */
export function themeGet(ctx: HandlerCtx<ServerDeps>): Theme {
  return ctx.deps.themeManager.getTheme();
}

export function themeGetSelectedName(ctx: HandlerCtx<ServerDeps>): string {
  return ctx.deps.themeManager.getSelectedThemeName();
}

export function themeHasGhosttyConfig(ctx: HandlerCtx<ServerDeps>): boolean {
  return ctx.deps.themeManager.hasGhosttyConfig();
}

export function themePreview(ctx: HandlerCtx<ServerDeps>, name: string): Theme {
  assertString(name, "name");
  return ctx.deps.themeManager.getThemeByName(name);
}

export function themeAllColors(
  ctx: HandlerCtx<ServerDeps>,
): Promise<Record<string, ThemeColors>> {
  return ctx.deps.themeManager.loadAllThemeColors();
}

/** Every theme in picker order, and the recent picks. */
export function themeCatalog(ctx: HandlerCtx<ServerDeps>): Promise<ThemeCatalog> {
  return ctx.deps.themeManager.catalog();
}

/** Count a theme as recent: Settings calls it on close for the picks it kept. */
export function themeAddRecent(ctx: HandlerCtx<ServerDeps>, name: string): void {
  assertString(name, "name");
  ctx.deps.themeManager.addRecent(name);
}

/**
 * Save a custom theme (a rename when `previousName` differs) and return its
 * selection name. Viewers hear the selected theme again: an edit to the
 * selected theme repaints them, and open pickers reload their list on it.
 */
export async function themeSaveCustom(
  ctx: HandlerCtx<ServerDeps>,
  name: string,
  theme: Theme,
  previousName?: string,
): Promise<string> {
  const next = assertThemeName(name);
  assertTheme(theme);
  const prev = previousName === undefined ? undefined : assertThemeName(previousName);
  const saved = ctx.deps.themeManager.saveCustomTheme(next, theme, prev);
  announce(ctx.deps.themeManager);
  if (prev !== undefined && prev !== next) {
    await repointProjects(ctx.deps, CUSTOM_PREFIX + prev, saved);
  }
  return saved;
}

/**
 * Delete a custom theme. If it was selected, every viewer goes back to the
 * default; projects that wore it go back to the global theme.
 */
export async function themeDeleteCustom(ctx: HandlerCtx<ServerDeps>, name: string): Promise<void> {
  const clean = assertThemeName(name);
  ctx.deps.themeManager.deleteCustomTheme(clean);
  announce(ctx.deps.themeManager);
  await repointProjects(ctx.deps, CUSTOM_PREFIX + clean, null);
}

/**
 * Move every project whose theme is `from` to `to` (null: the global
 * theme), so a rename or delete doesn't leave them on a name that no longer
 * resolves. Best effort: a remote project that can't be reached keeps its
 * old name and falls back to the default theme, as before.
 */
async function repointProjects(
  deps: Pick<ServerDeps, "projectManager">,
  from: string,
  to: string | null,
): Promise<void> {
  let changed = false;
  try {
    for (const project of await deps.projectManager.getProjects()) {
      if (project.themeName !== from) continue;
      try {
        await deps.projectManager.updateProject(project.id, { themeName: to });
        changed = true;
      } catch {
        // Unreachable remote project: see above.
      }
    }
  } finally {
    if (changed) publishRendererBroadcast("projects", "changed");
  }
}

function announce(manager: ServerDeps["themeManager"]): void {
  publishRendererBroadcast("theme", "changed", {
    name: manager.getSelectedThemeName(),
    theme: manager.getTheme(),
  });
}

/**
 * Select a theme and tell every viewer.
 *
 * A theme change is every viewer's, not just the caller's: without the
 * fan-out a second desktop window and every browser on the bridge would keep
 * the old theme until they next remounted. The `POST /theme`
 * route (CLI, MCP) calls this too, so it reaches the same viewers; it needs
 * only the theme manager, and has no caller to name.
 *
 * The caller learns the new theme from the return value;
 * `publishRendererBroadcast` covers everybody else.
 */
export function themeSetSelected(
  ctx: { deps: Pick<ServerDeps, "themeManager"> },
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
  catalog: method(themeCatalog),
  addRecent: method(themeAddRecent),
  saveCustom: method(themeSaveCustom),
  deleteCustom: method(themeDeleteCustom),
};
