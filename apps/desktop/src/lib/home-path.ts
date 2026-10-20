/**
 * The Home surface's sentinel workspace path, split into its own leaf module
 * with ZERO imports so the Electron main process can import it without pulling
 * in renderer-only code (`home.ts` transitively imports Zustand stores that
 * touch `window.electronAPI`). Renderer code should keep importing these from
 * `home.ts`, which re-exports them.
 *
 * See `home.ts` for the full rationale on the sentinel.
 */

/** Sentinel workspace path for the pinned, always-present "Home" surface. */
export const HOME_PATH = "__home__";

/** True when a workspace path refers to the home pseudo-workspace. */
export function isHomePath(path: string | null | undefined): boolean {
  return path === HOME_PATH;
}
