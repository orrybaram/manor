import {
  resolveOrchestratorAdapter,
  type OrchestratorHarnessPreferences,
} from "./harness";

/**
 * Sentinel workspace path for the pinned, always-present "Orchestrator"
 * surface. It keys a `WorkspaceLayout` in `app-store` exactly like a real
 * project workspace path — layout keying accepts opaque strings — but it has
 * no owning project. `~/.manor/orchestrator` is the real cwd the harness CLI
 * actually runs in (created lazily by the launch command; see
 * `orchestratorStartupCommand`).
 *
 * Renderer-safe: no electron imports.
 */
export const ORCHESTRATOR_PATH = "__orchestrator__";

/** Display/real cwd for the orchestrator harness. */
export const ORCHESTRATOR_CWD = "~/.manor/orchestrator";

/** True when a workspace path refers to the orchestrator pseudo-workspace. */
export function isOrchestratorPath(path: string | null | undefined): boolean {
  return path === ORCHESTRATOR_PATH;
}

/** Bare harness boot command for the configured orchestrator harness. */
export function orchestratorLaunchCommand(
  prefs: OrchestratorHarnessPreferences,
): string {
  return resolveOrchestratorAdapter(prefs).launchCommand();
}

/**
 * Wrap a command so it runs from the orchestrator's real cwd, creating the
 * directory lazily first. The orchestrator pane spawns its shell in $HOME (the
 * sentinel path is not a real directory), so the command itself is responsible
 * for `cd`-ing into the orchestrator workspace.
 */
export function wrapOrchestratorCwd(command: string): string {
  return `mkdir -p "$HOME/.manor/orchestrator" && cd "$HOME/.manor/orchestrator" && ${command}`;
}

/**
 * Full startup command that boots the configured harness inside the
 * orchestrator's cwd. Seeded into `pendingStartupCommand[ORCHESTRATOR_PATH]`
 * on auto-launch.
 */
export function orchestratorStartupCommand(
  prefs: OrchestratorHarnessPreferences,
): string {
  return wrapOrchestratorCwd(orchestratorLaunchCommand(prefs));
}
