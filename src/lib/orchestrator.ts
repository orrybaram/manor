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
 * Escape a prompt for interpolation inside a double-quoted shell argument.
 * Shared by the orchestrator's startup command (primer injection) and
 * `handleNewTaskWithPrompt` in `App.tsx` (seed-prompt injection) — both build
 * a launch command as `<harness> "<escaped prompt>"`, so they share one
 * escaping mechanism rather than each maintaining their own.
 */
export function escapeShellDoubleQuoted(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
}

/**
 * Full startup command that boots the configured harness inside the
 * orchestrator's cwd. Seeded into `pendingStartupCommand[ORCHESTRATOR_PATH]`
 * on auto-launch.
 *
 * `primerPrompt`, when given, is appended as the harness's first prompt —
 * `<harness> "<escaped primer>"` — the same harness-agnostic mechanism
 * `handleNewTaskWithPrompt` uses to seed a prompt. Omit it (e.g. on resume of
 * an existing session) to boot the bare harness with no seed prompt.
 */
export function orchestratorStartupCommand(
  prefs: OrchestratorHarnessPreferences,
  primerPrompt?: string,
): string {
  const launch = orchestratorLaunchCommand(prefs);
  const command = primerPrompt
    ? `${launch} "${escapeShellDoubleQuoted(primerPrompt)}"`
    : launch;
  return wrapOrchestratorCwd(command);
}
