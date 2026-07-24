import {
  resolveHomeAdapter,
  type HomeHarnessPreferences,
} from "./harness";

/**
 * The Home surface keys a `WorkspaceLayout` in `app-store` exactly like a real
 * project workspace path — layout keying accepts opaque strings — but it has
 * no owning project. `~/.manor/home` is the real cwd the harness CLI runs in,
 * created once at app startup (see `homeWorkspaceDir` / `initApp`). The Home
 * sentinel path resolves to that dir at the pty boundary (`resolveSpawnCwd` in
 * `electron/ipc/pty.ts`), so nothing here needs to `cd` into it.
 *
 * `HOME_PATH` / `isHomePath` live in the import-free `home-path` leaf module so
 * the Electron main process can import them; they are re-exported here so
 * renderer code has one place to import all home helpers from.
 */
export { HOME_PATH, isHomePath } from "./home-path";

/** Bare harness boot command for the configured home harness. */
export function homeLaunchCommand(prefs: HomeHarnessPreferences): string {
  return resolveHomeAdapter(prefs).launchCommand();
}

/**
 * Escape a prompt for interpolation inside a double-quoted shell argument.
 * Used by `handleNewTaskWithPrompt` in `App.tsx`, which builds a launch command
 * as `<harness> "<escaped prompt>"` to seed the harness's first prompt.
 */
export function escapeShellDoubleQuoted(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
}
