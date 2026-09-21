import { DEFAULT_AGENT_COMMAND } from "./agent-command";
import type { HomeHarnessPreferences } from "./harness";
import { homeLaunchCommand } from "./home";
import { isHomePath } from "./home-path";

/** The slice of a project `resolveAgentCommand` reads. */
export interface AgentCommandProject {
  agentCommand: string | null;
  workspaces: ReadonlyArray<{ path: string }>;
}

/**
 * The launch command for one workspace, most specific source first: an
 * explicit `override`, the home harness for the Home surface, the owning
 * project's `agentCommand`, then the default.
 *
 * Pure, and free of stores and managers, so both sides of the app ask the one
 * question the same way (ADR-182 D8): the renderer's `getAgentCommand`
 * (`src/agent-defaults.ts`) hands it Zustand state, and `POST /agents`
 * (`electron/routes/agents.ts`) hands it what the managers hold. It lives
 * outside `agent-defaults.ts` because that module reaches for the stores, and
 * outside the zero-import `agent-command.ts` leaf because the home harness
 * pulls in `harness.ts`, which imports that leaf back.
 */
export function resolveAgentCommand({
  override,
  workspacePath,
  homePrefs,
  projects,
}: {
  override?: string;
  workspacePath: string | null;
  homePrefs: HomeHarnessPreferences;
  projects: readonly AgentCommandProject[];
}): string {
  if (override) return override;
  if (isHomePath(workspacePath)) return homeLaunchCommand(homePrefs);
  if (!workspacePath) return DEFAULT_AGENT_COMMAND;
  const owner = projects.find((project) =>
    project.workspaces.some((workspace) => workspace.path === workspacePath),
  );
  return owner?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}
